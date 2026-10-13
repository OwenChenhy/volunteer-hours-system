const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const importService = require('../services/importService');
const { isExcelImportEnabled } = require('../utils/featureFlags');
const { writeAudit } = require('../services/auditService');
const cache = require('../cache/redis');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previewStore = new Map();

function cleanupPreviewStore() {
  const now = Date.now();
  for (const [id, preview] of previewStore.entries()) {
    if (now - preview.createdAt > PREVIEW_TTL_MS) {
      previewStore.delete(id);
    }
  }
}

function makePreviewRowKey(row) {
  return `${row?.sheet || ''}:${row?.row || ''}:${row?.student_id || ''}:${row?.student_name || ''}`;
}

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('import:manage'));

  // 预览 Excel
  fastify.post('/preview', async (request, reply) => {
    if (!isExcelImportEnabled()) {
      return reply.code(403).send({ message: 'Excel 导入功能已关闭' });
    }

    const data = await request.file();
    if (!data) return reply.code(400).send({ message: '请上传文件' });
    if (!/\.xlsx$/i.test(data.filename || '')) {
      return reply.code(400).send({ message: '仅支持 .xlsx 文件；旧版 .xls 请先另存为 .xlsx 后导入' });
    }

    const buffer = await data.toBuffer();
    const preview = await importService.parsePreview(buffer);
    cleanupPreviewStore();

    const previewId = crypto.randomUUID();
    previewStore.set(previewId, {
      userId: request.user.id,
      filename: data.filename,
      rows: preview.rows,
      file_hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      createdAt: Date.now()
    });

    return {
      preview_id: previewId,
      filename: data.filename,
      ...preview
    };
  });


  fastify.post('/prepare', async (request, reply) => {
    if (!isExcelImportEnabled()) return reply.code(403).send({ message: 'Excel导入功能已关闭' });
    cleanupPreviewStore();
    const body=request.body||{}, preview=previewStore.get(body.preview_id);
    if(!preview||preview.userId!==request.user.id) return reply.code(400).send({message:'预览已过期，请重新上传'});
    const datasetKey=String(body.dataset_key||'').trim(), note=String(body.note||'').trim();
    if(!datasetKey||datasetKey.length>160||!note||note.length>256) return reply.code(400).send({message:'请选择时长库并填写不超过256字的库名称'});
    const skipped=new Set(body.skipped_row_keys||[]), confirmed=new Set(body.confirmed_row_keys||[]);
    const options={dataset_key:datasetKey,replace_dataset:body.replace_dataset===true,note,
      default_activity_date:body.default_activity_date||'',default_activity_name:body.default_activity_name||'',
      default_academic_year:body.default_academic_year||'',default_academic_term:body.default_academic_term||'',default_grade:body.default_grade||''};
    try {
      const revisionBefore=(await db.query('SELECT revision FROM data_versions WHERE id=true')).rows[0].revision;
      const selected=[];
      for(const row of preview.rows) {
        if(skipped.has(makePreviewRowKey(row))) continue;
        if(row.status==='error') return reply.code(400).send({message:`第${row.row}行存在错误，请修正文件或明确跳过`});
        if(row.status==='warning'&&!confirmed.has(makePreviewRowKey(row))) return reply.code(400).send({message:`第${row.row}行的问题需要确认或跳过`});
        selected.push({...row,problem_confirmed:row.status==='warning'});
      }
      if(!selected.length) return reply.code(400).send({message:'没有可导入的记录'});
      const prior=(await db.query(`SELECT b.id,b.note,b.record_count,count(l.id) FILTER(WHERE l.status IN ('pending','approved','rejected'))::int AS active_record_count,COALESCE(sum(l.hours) FILTER(WHERE l.status='approved'),0) AS hours
        FROM import_batches b LEFT JOIN volunteer_logs l ON l.import_batch_id=b.id
        WHERE b.dataset_key=$1 AND b.superseded_at IS NULL GROUP BY b.id ORDER BY b.created_at DESC`,[datasetKey])).rows;
      if(prior.length&&!options.replace_dataset) return reply.code(409).send({message:'时长库已有版本，请选择更新已有库'});
      const priorIds=new Set(prior.map(batch=>batch.id));
      const active=(await db.query("SELECT student_id,activity_name,activity_date,is_adjustment,hours,adjustment_reason,import_batch_id FROM volunteer_logs WHERE status='approved'")).rows
        .filter(row=>!priorIds.has(row.import_batch_id));
      const known=new Set(active.map(importService.makeDuplicateKey)), seen=new Set(), records=[];
      let duplicateCount=0;
      for(const row of selected) {
        const {record}=await importService.prepareImportRow(row,options),key=importService.makeDuplicateKey(record);
        if(key&&(known.has(key)||seen.has(key))) {duplicateCount++;continue;}
        if(key)seen.add(key);
        records.push(record);
      }
      if(!records.length)return reply.code(400).send({message:'全部记录均为重复项，当前库无需变更'});
      const revision=(await db.query('SELECT revision FROM data_versions WHERE id=true')).rows[0].revision;
      if(String(revision)!==String(revisionBefore))return reply.code(409).send({message:'审核库在预览期间发生变化，请重新核对'});
      const confirmationId=crypto.randomUUID();
      preview.receipt={confirmationId,options:{...options,expected_revision:String(revision),file_hash:preview.file_hash,skipped_selected_count:skipped.size},rows:selected,revision:String(revision)};
      const oldHours=prior.reduce((total,batch)=>total+Math.round(Number(batch.hours)*10),0)/10;
      const newHours=records.reduce((total,row)=>total+Math.round(Number(row.hours)*10),0)/10;
      return {confirmation_id:confirmationId,dataset_key:datasetKey,note,filename:preview.filename,
        new_count:records.length,replaced_count:prior.reduce((total,batch)=>total+Number(batch.active_record_count||0),0),
        skipped_count:skipped.size+duplicateCount,total:preview.rows.length,old_hours:oldHours,new_hours:newHours,
        delta_hours:Math.round((newHours-oldHours)*10)/10,student_count:new Set(records.map(row=>row.student_id)).size,
        previous_batches:prior.map(({id,note,record_count})=>({id,note,record_count})),status:'approved_waiting_publication'};
    } catch(error) {
      if(error.code==='IMPORT_VALIDATION')return reply.code(400).send({message:error.message});
      throw error;
    }
  });

  // 确认导入
  fastify.post('/confirm', {
    schema: {
      body: {
        type: 'object',
        required: ['preview_id'],
        properties: {
          preview_id: { type: 'string' },
          confirmation_id: { type: 'string' },
          confirmed_row_keys: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          filename: { type: 'string' },
          default_activity_date: { type: 'string' },
          default_activity_name: { type: 'string' },
          default_academic_year: { type: 'string' },
          default_academic_term: { type: 'string' },
          default_grade: { type: 'string', maxLength: 16 },
          replace_existing_note: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    if (!isExcelImportEnabled()) {
      return reply.code(403).send({ message: 'Excel 导入功能已关闭' });
    }

    const {
      preview_id,
      confirmed_row_keys,
      note,
      default_activity_date,
      default_activity_name,
      replace_existing_note
    } = request.body;
    try {
      cleanupPreviewStore();
      const preview = previewStore.get(preview_id);
      if (!preview || preview.userId !== request.user.id) {
        return reply.code(400).send({ message: '预览已过期或不存在，请重新上传文件预览' });
      }


      if(request.body.confirmation_id) {
        const receipt=preview.receipt;
        if(!receipt||receipt.confirmationId!==request.body.confirmation_id) return reply.code(400).send({message:'确认摘要已失效，请重新核对'});
        if(receipt.running) return reply.code(409).send({message:'该批次正在执行，请稍后查看结果'});
        if(receipt.result) return receipt.result;
        receipt.running=true;
        try {
          const result=await importService.confirmImport(receipt.rows,request.user.id,receipt.options.note,preview.filename,receipt.options);
          receipt.result={...result,filename:preview.filename,note:receipt.options.note,dataset_key:receipt.options.dataset_key,
            skipped_selected_count:receipt.options.skipped_selected_count,status:'approved_waiting_publication',message:'导入完成，待统一发布后更新正式时长'};
          await writeAudit(request,'import.confirm','import_batch',result.batch_id,{count:result.count,dataset_key:receipt.options.dataset_key,
            replaced_record_count:result.replaced_record_count,filename:preview.filename});
          await cache.deleteByPrefix('query:');
          return receipt.result;
        } finally {receipt.running=false;}
      }

      const confirmedSet = new Set(confirmed_row_keys || []);
      const unconfirmedWarnings = preview.rows.filter(
        (row) => row.status === 'warning' && !confirmedSet.has(makePreviewRowKey(row))
      );
      if (unconfirmedWarnings.length > 0) {
        return reply.code(400).send({
          message: `还有 ${unconfirmedWarnings.length} 条问题数据未确认，请确认后再导入`
        });
      }

      const rows = preview.rows
        .filter((row) => row.status === 'ok' || (row.status === 'warning' && confirmedSet.has(makePreviewRowKey(row))))
        .map((row) => ({
          ...row,
          problem_confirmed: row.status === 'warning'
        }));

      if (rows.length === 0) {
        return reply.code(400).send({ message: '没有可导入的记录，请先确认问题行或修正原始数据' });
      }

      const result = await importService.confirmImport(rows, request.user.id, note, preview.filename, {
        default_activity_date,
        default_activity_name,
        replace_existing_note,
        file_hash: preview.file_hash,
        default_academic_year: request.body.default_academic_year,
        default_academic_term: request.body.default_academic_term,
        default_grade: request.body.default_grade
      });
      previewStore.delete(preview_id);
      await writeAudit(request, 'import.confirm', 'import_batch', result.batch_id, {
        count: result.count,
        confirmed_problem_count: result.confirmed_problem_count,
        replaced_batch_count: result.replaced_batch_count,
        replaced_record_count: result.replaced_record_count,
        preview_id,
        filename: preview.filename,
        note
      });
      await cache.deleteByPrefix('query:');
      return result;
    } catch (err) {
      if (err.code === 'IMPORT_VALIDATION') {
        request.log.warn({ err }, 'Import confirmation rejected');
        return reply.code(400).send({ message: err.message || '导入确认失败' });
      }
      request.log.error({ err }, 'Import confirmation failed');
      return reply.code(500).send({ message: '导入确认失败，请稍后重试' });
    }
  });

  // 获取导入批次列表
  fastify.get('/batches', async (request, reply) => {
    const { rows } = await db.query('SELECT * FROM import_batches ORDER BY created_at DESC');
    return rows;
  });

  fastify.get('/template', async (request, reply) => {
    const headers = ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式', '学年', '归属阶段', '录入类型', '调整说明'];
    const sample = ['TEST-STUDENT-003', '测试用户', '计算机科学与工程学院', '25级', '社区志愿服务', '2026-04-25', 2.5, ''];
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('标准导入模板');
    worksheet.addRows([headers, [...sample, '2025-2026', '下半年', '活动', ''], ['TEST-STUDENT-003', '测试用户', '计算机科学与工程学院', '25级', '活动时长扣减', '2026-04-25', -0.5, '', '2025-2026', '下半年', '调整', '审核后扣减重复时长']]);
    worksheet.columns.forEach((column) => {
      column.width = 18;
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="volunteer-import-template.xlsx"')
      .send(buffer);
  });
};

