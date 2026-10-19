import { useEffect, useState } from 'react';
import { archiveActivity, createActivity, deleteActivity, downloadParticipantTemplate, getActivity, listActivities, previewParticipantFile, previewParticipants, restoreActivity, submitLogs, unarchiveActivity, updateActivity } from './api';
import { useSession } from './SessionContext';
import { ActionDialog, Banner, Field, Panel, Steps, Table, hours, useUnsavedChanges } from './UxUI';
import RecordsPage from './RecordsPage';
const emptyForm = {
  name: '',
  start_time: '',
  end_time: '',
  location: '',
  org_name: '',
  description: '',
  academic_year: '',
  academic_term: ''
};
const labels = {
  student_id: '学号',
  student_name: '姓名',
  college: '学院',
  grade: '年级',
  hours: '时长（小时）',
  phone: '联系方式'
};
const localTime = value => value ? new Date(value).toLocaleString('sv-SE', {
  timeZone: 'Asia/Shanghai'
}).replace(' ', 'T').slice(0, 16) : '';
const payload = form => ({
  ...form,
  start_time: form.start_time ? `${form.start_time}:00+08:00` : null,
  end_time: form.end_time ? `${form.end_time}:00+08:00` : null
});
export default function ActivityWorkspace({
  startWithSubmission = false
}) {
  const {
    user
  } = useSession();
  const [activities, setActivities] = useState([]),
    [view, setView] = useState('list'),
    [activity, setActivity] = useState(null),
    [form, setForm] = useState(emptyForm),
    [step, setStep] = useState(0),
    [rows, setRows] = useState([]),
    [entry, setEntry] = useState('manual'),
    [paste, setPaste] = useState(''),
    [receipt, setReceipt] = useState(null),
    [submissionKey, setSubmissionKey] = useState(''),
    [search, setSearch] = useState(''),
    [deleted, setDeleted] = useState(false),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [dialog, setDialog] = useState(null),
    [formDirty, setFormDirty] = useState(false),
    [rosterDirty, setRosterDirty] = useState(false);
  const dirty = formDirty || rosterDirty;
  useUnsavedChanges(dirty);
  const newRow = () => ({
    student_id: '',
    student_name: '',
    college: user.org_name || activity?.org_name || '',
    grade: '',
    hours: '',
    phone: ''
  });
  function clearDirty() {
    setFormDirty(false);
    setRosterDirty(false);
  }
  async function load() {
    setError('');
    try {
      setActivities(await listActivities({
        include_deleted: deleted ? 'true' : ''
      }));
    } catch (failure) {
      setError(failure.message);
    }
  }
  useEffect(() => {
    load();
  }, [deleted]);
  async function details(id) {
    setBusy(true);
    setError('');
    try {
      setActivity(await getActivity(id));
      setView('detail');
      clearDirty();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function fill(value) {
    setForm({
      ...emptyForm,
      ...value,
      historical: !!value && !value.start_time,
      start_time: localTime(value?.start_time),
      end_time: localTime(value?.end_time),
      academic_year: value?.academic_year_inferred ? '' : value?.academic_year || '',
      academic_term: value?.academic_term_inferred ? '' : value?.academic_term || '',
      org_name: value?.org_name || user.org_name || ''
    });
  }
  function create() {
    setActivity(null);
    fill(null);
    setRows([]);
    setReceipt(null);
    setStep(0);
    setView('wizard');
    clearDirty();
    setError('');
    setMessage('');
  }
  function participants(value) {
    setActivity(value);
    fill(value);
    setRows([{
      ...newRow(),
      college: user.org_name || value.org_name || ''
    }]);
    setReceipt(null);
    setStep(1);
    setView('wizard');
    setEntry('manual');
    clearDirty();
    setError('');
  }
  function edit(value) {
    setActivity(value);
    fill(value);
    setStep(0);
    setView('edit');
    clearDirty();
    setError('');
  }
  function changeForm(key, value) {
    setForm(current => ({
      ...current,
      [key]: value
    }));
    setFormDirty(true);
  }
  async function saveInfo(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = activity ? await updateActivity(activity.id, payload(form)) : await createActivity(payload(form));
      const fresh = await getActivity(saved.id);
      setActivity(fresh);
      setFormDirty(false);
      await load();
      if (view === 'edit') {
        setView('detail');
        setMessage('活动信息已更新');
      } else {
        setStep(1);
        if (!rows.length) setRows([{
          ...newRow(),
          college: user.org_name || saved.org_name || ''
        }]);
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function changeRow(index, key, value) {
    setRows(current => current.map((row, n) => n === index ? {
      ...row,
      [key]: value,
      errors: [],
      duplicate: false
    } : row));
    setReceipt(null);
    setRosterDirty(true);
  }
  function parsePaste() {
    const lines = paste.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0]?.startsWith('学号')) lines.shift();
    setRows(lines.map(line => {
      const values = line.split(/\t|,|，/);
      return Object.fromEntries(Object.keys(labels).map((key, index) => [key, values[index]?.trim() || '']));
    }));
    setReceipt(null);
    setEntry('manual');
    setRosterDirty(true);
  }
  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = await previewParticipantFile(activity.id, file);
      setRows(result.rows);
      setReceipt(null);
      setEntry('manual');
      setRosterDirty(true);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setError('');
    try {
      const result = await previewParticipants({
        activity_id: activity.id,
        records: rows.map(row => ({
          ...row,
          hours: Number(row.hours)
        }))
      });
      setRows(result.rows);
      if (result.errors) {
        setError(`还有${result.errors}行需要修正，问题已标在对应行。`);
        return;
      }
      setReceipt(result);
      setSubmissionKey(crypto.randomUUID());
      setStep(2);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const result = await submitLogs({
        activity_id: activity.id,
        records: receipt.rows,
        submission_key: submissionKey
      });
      setRosterDirty(false);
      setMessage(result.message);
      setStep(3);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    const value = dialog.activity;
    if (dialog.action === 'delete') await deleteActivity(value.id);else if (dialog.action === 'restore') await restoreActivity(value.id);else if (value.status === 'archived') await unarchiveActivity(value.id);else await archiveActivity(value.id);
    setDialog(null);
    setMessage(dialog.action === 'delete' ? '活动已删除，操作历史保留' : '活动状态已更新');
    setView('list');
    await load();
  }
  function leave() {
    if (dirty && !window.confirm('还有未保存的活动信息或未提交的名单，确定返回吗？')) return;
    clearDirty();
    setView(view === 'detail' ? 'list' : activity ? 'detail' : 'list');
  }
  const filtered = activities.filter(value => `${value.name} ${value.org_name || ''}`.toLowerCase().includes(search.toLowerCase()));
  const visible = filtered.slice((page - 1) * 25, page * 25);
  return <section className="dashboard-section"><div className="section-title"><div><h2>{view === 'list' ? startWithSubmission ? '选择活动填报名单' : '活动管理' : view === 'detail' ? activity?.name : view === 'edit' ? '编辑活动' : '新建活动与名单'}</h2><p>{view === 'list' ? '从活动进入名单填报、查看审核进度和管理记录。' : '活动信息、参与名单和审核进度始终关联同一场活动。'}</p></div>{view === 'list' ? <button className="primary-button" onClick={create}>新建活动</button> : <button disabled={busy} onClick={leave}>返回{view === 'detail' ? '活动列表' : activity ? '活动详情' : '活动列表'}</button>}</div><Banner error={error} message={message} />
    {view === 'list' && <><div className="toolbar"><Field label="查找活动"><input type="search" value={search} onChange={event => {
            setSearch(event.target.value);
            setPage(1);
          }} placeholder="活动名称或负责单位" /></Field><label className="inline-check"><input type="checkbox" checked={deleted} onChange={event => {
            setDeleted(event.target.checked);
            setPage(1);
          }} />显示已删除活动</label><button onClick={load}>刷新列表</button></div><Panel title={`活动列表 · ${filtered.length}场`}><Table columns={['活动', '时间 / 学年', '负责单位', '名单进度', '状态', '操作']} rows={visible.map(value => [<strong>{value.name}</strong>, <span>{value.start_time ? localTime(value.start_time).replace('T', ' ') : '未注明具体日期'}<small className="ux-muted">{value.academic_year === 'legacy' ? '历史导入' : value.academic_year} · {value.term_label}</small></span>, value.org_name || '未填写', `${value.record_count}人 · 待审${value.pending_count}`, value.deleted_at ? '已删除' : value.status === 'archived' ? '已归档' : '可填报', <div className="row-actions">{value.deleted_at ? <button onClick={() => setDialog({
            action: 'restore',
            activity: value,
            title: '恢复活动',
            description: `恢复${value.name}，保留原活动和名单关联。`,
            confirm: '确认恢复'
          })}>恢复</button> : <><button onClick={() => details(value.id)}>查看详情</button>{value.status === 'active' && value.start_time && <button onClick={() => participants(value)}>填报名单</button>}<button className="danger-text" onClick={() => setDialog({
              action: 'delete',
              activity: value,
              danger: true,
              blocked: value.record_count > 0,
              title: '删除活动',
              description: value.record_count ? `${value.name}仍有${value.record_count}条有效名单。请在详情中先撤回或作废记录，或选择归档。` : `删除${value.name}。活动不再出现在常用列表，可从已删除列表恢复。`,
              confirm: '确认删除'
            })}>删除</button></>}</div>])} /><div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>第{page}页 / 共{Math.max(1, Math.ceil(filtered.length / 25))}页</span><button disabled={page * 25 >= filtered.length} onClick={() => setPage(page + 1)}>下一页</button></div></Panel></>}
    {view === 'detail' && activity && <><Panel title="活动信息" action={<div className="row-actions"><button onClick={() => edit(activity)}>编辑信息</button>{!activity.deleted_at && activity.status === 'active' && activity.start_time && <button className="primary-button" onClick={() => participants(activity)}>继续填报名单</button>}<button onClick={() => setDialog({
          action: 'archive',
          activity,
          title: activity.status === 'archived' ? '恢复填报' : '归档活动',
          description: activity.status === 'archived' ? '恢复后可继续提交名单。' : '归档后停止继续填报，已有时长和审核记录保留。',
          confirm: '确认操作'
        })}>{activity.status === 'archived' ? '恢复填报' : '归档'}</button></div>}><div className="ux-detail-grid"><p><strong>活动时间</strong>{activity.start_time ? `${localTime(activity.start_time).replace('T', ' ')} 至 ${localTime(activity.end_time).replace('T', ' ')}` : '未注明具体日期'}</p><p><strong>负责单位</strong>{activity.org_name || '未填写'}</p><p><strong>学年 / 阶段</strong>{activity.academic_year === 'legacy' ? '历史导入' : activity.academic_year} / {activity.term_label}</p><p><strong>活动地点</strong>{activity.location || '未填写'}</p></div>{activity.description && <p>{activity.description}</p>}</Panel><div className="ux-progress-grid">{Object.entries({
          pending: '待审核',
          rejected: '需修正',
          waiting_publication: '通过待发布',
          published: '当前已发布'
        }).map(([key, label]) => <article className="metric-card" key={key}><span>{label}</span><strong>{activity.counts?.[key] || 0}</strong></article>)}</div><RecordsPage activityId={activity.id} onChange={async () => setActivity(await getActivity(activity.id))} /></>}
    {(view === 'wizard' || view === 'edit') && <>{view === 'wizard' && <Steps labels={['活动信息', '参与名单', '核对并提交', '提交结果']} current={step} />}{activity && <p className="ux-context">当前活动：<strong>{activity.name}</strong> · {activity.org_name}</p>}
      {(step === 0 || view === 'edit') && <Panel title="填写活动基本信息"><form className="form-grid" onSubmit={saveInfo}><Field label="活动名称"><input required maxLength={256} value={form.name} onChange={event => changeForm('name', event.target.value)} /></Field><Field label="负责单位"><input required readOnly={user.role === 'college_admin'} maxLength={128} value={form.org_name} onChange={event => changeForm('org_name', event.target.value)} /></Field><Field label="开始时间（北京时间）"><input type="datetime-local" required={!form.historical} value={form.start_time} onChange={event => changeForm('start_time', event.target.value)} /></Field><Field label="结束时间（北京时间）"><input type="datetime-local" required={!form.historical} min={form.start_time || undefined} value={form.end_time} onChange={event => changeForm('end_time', event.target.value)} /></Field><Field label="地点（可选）"><input maxLength={128} value={form.location} onChange={event => changeForm('location', event.target.value)} /></Field><Field label="活动说明（可选）"><textarea maxLength={4000} value={form.description} onChange={event => changeForm('description', event.target.value)} /></Field><details className="ux-advanced"><summary>学年与阶段设置</summary><p>默认按真实活动日期和学校月份规则归类；特殊归属可在这里指定。</p><Field label="指定学年"><input value={form.academic_year} placeholder="例如2026-2027" onChange={event => changeForm('academic_year', event.target.value)} /></Field><Field label="指定阶段"><select value={form.academic_term} onChange={event => changeForm('academic_term', event.target.value)}><option value="">自动归类</option><option value="upper">上半年</option><option value="lower">下半年</option><option value="vacation">寒暑假补录</option><option value="unassigned">未分期</option></select></Field></details><div className="form-actions"><button type="button" onClick={leave}>取消</button><button className="primary-button" disabled={busy}>{busy ? '保存中…' : view === 'edit' ? '保存活动信息' : '保存活动，继续录入名单'}</button></div></form></Panel>}
      {view === 'wizard' && step === 1 && <Panel title="录入参与名单"><div className="ux-entry-options">{Object.entries({
            manual: '表格录入',
            paste: 'Excel复制粘贴',
            file: '上传名单文件'
          }).map(([key, label]) => <button key={key} className={entry === key ? 'selected' : ''} onClick={() => setEntry(key)}>{label}</button>)}</div>
        {entry === 'paste' && <div className="stack-form"><Field label="粘贴名单" hint="列顺序：学号、姓名、学院、年级、时长、联系方式；支持带表头的Excel复制内容。"><textarea rows={8} value={paste} onChange={event => {
              setPaste(event.target.value);
              setRosterDirty(true);
            }} /></Field><button disabled={!paste.trim()} onClick={parsePaste}>解析并编辑名单</button></div>}
        {entry === 'file' && <div className="stack-form"><p>名单只提交当前活动，并进入待审核。</p><button onClick={() => downloadParticipantTemplate().catch(failure => setError(failure.message))}>下载活动名单模板</button><Field label="上传Excel名单"><input type="file" accept=".xlsx" disabled={busy} onChange={event => upload(event.target.files?.[0])} /></Field></div>}
        {entry === 'manual' && <><div className="ux-participant-list">{rows.map((row, index) => <article className="ux-participant-row" key={index}><div className="ux-participant-index">第{index + 1}行<button aria-label={`移除第${index + 1}行`} onClick={() => {
                  setRows(rows.filter((_, n) => n !== index));
                  setRosterDirty(true);
                  setReceipt(null);
                }}>移除</button></div><div className="ux-participant-fields">{Object.entries(labels).map(([key, label]) => <Field key={key} label={label}><input aria-label={`第${index + 1}行${label}`} type={key === 'hours' ? 'number' : 'text'} min={key === 'hours' ? '0.1' : undefined} step={key === 'hours' ? '0.1' : undefined} value={row[key] ?? ''} onChange={event => changeRow(index, key, event.target.value)} /></Field>)}</div>{row.errors?.length > 0 && <p className="notice error" role="alert">{row.errors.join('；')}</p>}</article>)}</div><div className="toolbar"><button onClick={() => {
              setRows([...rows, newRow()]);
              setRosterDirty(true);
            }}>增加一行</button>{rows.some(row => row.duplicate) && <button onClick={() => {
              setRows(rows.filter(row => !row.duplicate));
              setReceipt(null);
              setRosterDirty(true);
            }}>移除重复行</button>}</div></>}
        <div className="ux-flow-footer"><button onClick={() => setStep(0)}>上一步：活动信息</button><button className="primary-button" disabled={busy || !rows.length || entry !== 'manual'} onClick={preview}>{busy ? '正在校验…' : '校验名单，进入预览'}</button></div></Panel>}
      {view === 'wizard' && step === 2 && receipt && <Panel title="核对名单并提交"><div className="ux-summary"><strong>{receipt.rows.length}名学生</strong><span>总时长 {hours(receipt.rows.reduce((total, row) => total + Number(row.hours), 0))} 小时</span><span>提交后进入待审核</span></div><Table columns={['学号', '姓名', '学院', '年级', '时长']} rows={receipt.rows.map(row => [row.student_id, row.student_name, row.college, row.grade || '未填写', hours(row.hours)])} /><div className="ux-flow-footer"><button disabled={busy} onClick={() => setStep(1)}>返回修改名单</button><button disabled={busy} className="primary-button" onClick={submit}>{busy ? '提交中…' : '确认提交审核'}</button></div></Panel>}
      {view === 'wizard' && step === 3 && <Panel title="名单已提交"><p role="status">办公室审核后可查看通过或驳回结果；通过的记录等待统一发布后计入正式时长。</p><div className="form-actions"><button className="primary-button" onClick={() => details(activity.id)}>查看活动与审核进度</button><button onClick={() => {
            setView('list');
            setActivity(null);
          }}>返回活动列表</button></div></Panel>}
    </>}
    <ActionDialog dialog={dialog} onClose={() => setDialog(null)} onConfirm={confirm} />
  </section>;
}
