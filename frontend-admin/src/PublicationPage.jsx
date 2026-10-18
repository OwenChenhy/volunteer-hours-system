import { useEffect, useState } from 'react';
import { exportPublication, getPublicationStatus, publishHours } from './api';

export default function PublicationPage() {
  const [status, setStatus] = useState(null);
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7));
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  async function refresh() {
    try { setStatus(await getPublicationStatus()); }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { refresh(); }, []);
  async function download(id) {
    setExporting(true); setMessage('');
    try {
      await exportPublication(id);
      setMessage('公示Excel压缩包已生成并开始下载。');
    } catch (error) { setMessage(error.message); }
    finally { setExporting(false); }
  }
  async function publish(event) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const result = await publishHours({ publication_month: month, label: label.trim() || `${month}累计时长公示` });
      setMessage(`已统一发布：${result.source_name}`);
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  const pending = status?.counts.pending || 0;
  return <section className="panel">
    <h2>统一发布时长库</h2>
    <p>学院提交活动和参与名单，办公室完成全部审核后，由管理员统一发布。审核通过但尚未发布的活动不计入学生正式时长和排名。</p>
    {message && <p role="status">{message}</p>}
    {status && <>
      <p>当前公示：{status.published.source_name} · {status.published.record_count}条 · {new Date(status.published.last_updated_at).toLocaleString('zh-CN')}</p>
      <button type="button" disabled={busy || exporting} onClick={() => download(status.published.publication_id)}>{exporting ? '正在生成公示Excel…' : '导出当前公示Excel（ZIP）'}</button>
      <p>按参考时长库的学院文件、年级工作表及表头样式导出，缺少原表的学院参照计算机学院模板。只包含所选已发布版本；未知学期的历史明细保留在备注，无备注列的原表使用时长单元格批注。公示未保存的性别、联系方式留空。</p>
      <p>待审核：{pending}条；审核通过（含历史）：{status.counts.approved || 0}条；{status.has_changes ? '审核库有更新，尚未统一发布。' : '审核库与当前公示一致。'}</p>
      <form className="form-grid" onSubmit={publish}>
        <label className="field"><span>公示月份</span><input type="month" value={month} onChange={event => setMonth(event.target.value)} required /></label>
        <label className="field"><span>公示说明</span><input value={label} onChange={event => setLabel(event.target.value)} maxLength={128} placeholder={`${month}累计时长公示`} /></label>
        <div className="form-actions"><button className="primary-button" type="submit" disabled={busy || exporting || pending > 0 || (!status.has_changes && month === status.published.publication_month)}>{busy ? '计算汇总并发布中…' : '全部审核完成，统一发布'}</button>
        <button className="secondary-button" type="button" onClick={refresh} disabled={busy}>刷新审核状态</button></div>
      </form>
      {pending > 0 && <p>请在“审核”模块处理剩余记录后再发布。</p>}
      <h3>发布记录</h3>
      <div className="table-wrap"><table><thead><tr><th>月份</th><th>说明</th><th>记录数</th><th>累计时长</th><th>发布时间</th><th>操作</th></tr></thead>
      <tbody>{status.history.map(row => <tr key={row.id}><td>{row.publication_month}</td><td>{row.label}</td><td>{row.record_count}</td><td>{row.total_hours}</td><td>{new Date(row.published_at).toLocaleString('zh-CN')}</td><td><button type="button" disabled={busy || exporting} onClick={() => download(row.id)}>导出Excel（ZIP）</button></td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
