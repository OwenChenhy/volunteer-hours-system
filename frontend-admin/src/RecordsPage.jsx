import { useEffect, useState } from 'react';
import { approveLog, rejectLog, batchApprove, listLogs, retireLog, restoreLog, resubmitLog } from './api';
import { useSession } from './SessionContext';
import { ActionDialog, Banner, Field, Panel, Table, hours, states } from './UxUI';
export default function RecordsPage({
  activityId,
  onChange,
  review = false
}) {
  const {
    user,
    can
  } = useSession();
  const [rows, setRows] = useState([]),
    [status, setStatus] = useState(''),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [dialog, setDialog] = useState(null),
    [editing, setEditing] = useState(null),
    [selected, setSelected] = useState([]);
  async function load() {
    setBusy(true);
    setError('');
    try {
      setRows(await listLogs({
        activity_id: activityId,
        status,
        include_inactive: history ? 'true' : '',
        limit: 1000
      }));
      setSelected([]);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, [activityId, status, history]);
  async function execute(action, text) {
    setError('');
    setBusy(true);
    try {
      await action();
      setMessage(text);
      setDialog(null);
      await load();
      await onChange?.();
    } catch (failure) {
      setError(failure.message);
      throw failure;
    } finally {
      setBusy(false);
    }
  }
  async function confirm({
    reason
  }) {
    const row = dialog.row;
    if (dialog.action === 'reject') await execute(() => rejectLog(row.id, reason), '已驳回，提交者可修正后重新提交');else if (dialog.action === 'restore') await execute(() => restoreLog(row.id, reason), '记录已恢复，正式时长由统一发布更新');else await execute(() => retireLog(row.id, reason), row.status === 'approved' ? '记录已作废，等待统一发布更正' : '记录已撤回，可修正后重新提交');
  }
  return <section className="dashboard-section">
    {!activityId && <div><h2>{review ? '审核与记录管理' : '提交记录与进度'}</h2><p>审核通过后等待管理员统一发布，正式时长和排名才会更新。</p></div>}
    <Banner error={error} message={message} />
    <div className="toolbar"><Field label="记录状态"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部有效记录</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><label className="inline-check"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />显示撤回和作废历史</label><button disabled={busy} onClick={load}>刷新进度</button>
      {review && can('logs:review') && <button disabled={busy || !selected.length} onClick={() => execute(() => batchApprove(selected), '所选待审核记录已通过').catch(() => {})}>通过所选 {selected.length || ''}</button>}</div>
    {editing && <Panel title="修正后重新提交"><form className="form-grid" onSubmit={event => {
        event.preventDefault();
        execute(() => resubmitLog(editing.id, {
          ...editing,
          hours: Number(editing.hours)
        }), '已重新提交，等待审核').then(() => setEditing(null)).catch(() => {});
      }}>
      {Object.entries({
          student_id: '学号',
          student_name: '姓名',
          college: '学院',
          grade: '年级',
          hours: '服务时长',
          phone: '联系方式'
        }).map(([key, label]) => <Field key={key} label={label}><input required={['student_id', 'student_name', 'college', 'hours'].includes(key)} type={key === 'hours' ? 'number' : 'text'} min={key === 'hours' ? '0.1' : undefined} step={key === 'hours' ? '0.1' : undefined} value={editing[key] || ''} onChange={event => setEditing({
            ...editing,
            [key]: event.target.value
          })} /></Field>)}<div className="form-actions"><button type="button" onClick={() => setEditing(null)}>取消修改</button><button disabled={busy} className="primary-button">提交审核</button></div></form></Panel>}
    <Panel title={`名单记录 · ${rows.length}条`}><Table columns={['学生', '活动', '学院 / 年级', '时长', '审核状态', '操作']} rows={rows.map(row => {
        const owns = can('logs:submit') && row.submitted_by === user.id,
          reviewer = can('logs:review');
        return [<span>{review && row.status === 'pending' && <input className="ux-row-check" aria-label={`选择${row.student_name}`} type="checkbox" checked={selected.includes(row.id)} onChange={event => setSelected(event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />}<strong>{row.student_name}</strong><small className="ux-muted">{row.student_id}</small></span>, row.activity_name, `${row.college || '未填写'} / ${row.grade || '未填写'}`, hours(row.hours), <span className={`ux-state state-${row.status}`}>{states[row.status]}{row.status === 'approved' && <small>{row.publication_status === 'published' ? '已计入当前公示' : '通过待统一发布'}</small>}{row.reject_reason && <small>{row.reject_reason}</small>}{row.lifecycle_reason && <small>{row.lifecycle_reason}</small>}</span>, <div className="row-actions">
        {row.status === 'pending' && reviewer && <><button disabled={busy} onClick={() => execute(() => approveLog(row.id), '审核通过，等待统一发布').catch(() => {})}>通过</button><button onClick={() => setDialog({
              action: 'reject',
              row,
              reason: true,
              title: '驳回名单记录',
              description: `${row.student_name} · ${row.activity_name}。请说明需要修正的内容。`,
              confirm: '确认驳回'
            })}>驳回</button></>}
        {['pending', 'rejected'].includes(row.status) && (owns || reviewer) && <button onClick={() => setDialog({
            action: 'retire',
            row,
            reason: true,
            danger: true,
            title: '撤回名单记录',
            description: `${row.student_name} · ${hours(row.hours)}小时。保留操作历史，可修正后重新提交。`,
            confirm: '确认撤回'
          })}>撤回</button>}
        {row.status === 'approved' && reviewer && <button className="danger-text" onClick={() => setDialog({
            action: 'retire',
            row,
            reason: true,
            danger: true,
            title: '作废时长记录',
            description: `${row.student_name} · ${hours(row.hours)}小时。当前公示仍保留原结果，下次统一发布后更正正式时长。`,
            confirm: '确认作废'
          })}>作废</button>}
        {['rejected', 'withdrawn'].includes(row.status) && owns && <button onClick={() => setEditing({
            ...row
          })}>修正重提</button>}
        {(row.status === 'voided' && reviewer || row.status === 'withdrawn' && (owns || reviewer)) && <button onClick={() => setDialog({
            action: 'restore',
            row,
            reason: true,
            title: '恢复记录',
            description: `恢复${row.student_name}的记录。系统将检查活动状态和重复记录。`,
            confirm: '确认恢复'
          })}>恢复</button>}
      </div>];
      })} />{rows.length === 1000 && <p>已显示最近1000条记录，请按活动或状态缩小范围。</p>}</Panel>
    <ActionDialog dialog={dialog} onClose={() => setDialog(null)} onConfirm={confirm} />
  </section>;
}
