import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const hours = (n) => Number(n || 0).toFixed(1);
const legacyLabel = '未注明学年的历史记录';

export default function AcademicSummary({ result }) {
  const summaries = result.academic_summaries || [];
  const [selectedYear, setSelectedYear] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const year = summaries.some((item) => item.academic_year === selectedYear) ? selectedYear : summaries[0]?.academic_year;
  const personal = summaries.find((item) => item.academic_year === year);
  const historical = year === 'legacy';
  const fields = ['upper_hours', 'lower_hours', 'vacation_hours', 'unassigned_hours', 'total_hours'];
  const columns = ['排名', '学号', '姓名', '年级', '上半年', '下半年', '寒暑假补录', '未归类时长', '净总时长'];
  const id = result.student.student_id;
  const name = result.student.student_name;
  const revision = result.data_version?.revision;
  useEffect(() => {
    if (!year) return;
    const controller = new AbortController(); setData(null); setError('');
    fetch(`${API_BASE}/api/v1/query/summary`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: controller.signal, body: JSON.stringify({ student_id: id, student_name: name, academic_year: year, publication_id: result.data_version?.publication_id, page, limit: 25 }) })
      .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.message || '汇总表读取失败'); return payload; })
      .then((payload) => { if (!controller.signal.aborted) setData(payload); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [id, name, year, page, revision]);
  if (!summaries.length) return null;
  return <section className="academic-summary" aria-label="学年汇总表">
    <div className="records-header"><div><h3>时长汇总表</h3><p>按同学院同年级的净时长降序，相同时长并列。其他同学身份信息已脱敏。</p></div><label>范围 <select aria-label="选择汇总范围" value={year || ''} onChange={(e) => { setSelectedYear(e.target.value); setPage(1); }}>{summaries.map((item) => item.academic_year && <option key={item.academic_year} value={item.academic_year}>{item.academic_year === 'legacy' ? legacyLabel : item.academic_year}</option>)}</select></label></div>
    <p className="academic-personal">{historical ? '本人历史累计：' : '本人本学年：'}上半年 {hours(personal?.upper_hours)} ＋ 下半年 {hours(personal?.lower_hours)} ＋ 寒暑假 {hours(personal?.vacation_hours)} ＋ 未归类 {hours(personal?.unassigned_hours)} ＝ <strong>{hours(personal?.total_hours)} 小时</strong>；排名 {personal?.rank || '待确认'} / {personal?.total_students || 0}</p>
    {error && <p role="status">{error}。本人汇总仍显示在上方。</p>}
    {!data && !error && <p role="status">正在读取最新汇总表…</p>}
    {data && <><div className="table-wrap"><table><thead><tr>{columns.map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr className={row.is_self ? 'academic-self' : ''} key={`${row.rank}-${index}`}><td>{row.rank}</td><td>{row.student_id}</td><td>{row.student_name}{row.is_self ? '（本人）' : ''}</td><td>{row.grade}</td>{fields.map((field) => <td key={field}>{hours(row[field])}</td>)}</tr>)}</tbody></table>{data.rows.length === 0 && <p>当前范围暂无已审核记录。</p>}</div><div className="academic-pagination"><span>共 {data.total_students} 人 · 第 {page} 页</span><button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>上一页</button><button type="button" className="secondary-button" disabled={page * 25 >= data.total_students} onClick={() => setPage((n) => n + 1)}>下一页</button></div></>}
    <p className="data-note">{historical ? '原表未注明学年的记录仍保留寒暑假等阶段分类，不推算缺失学年或具体日期。' : '历史记录按原表学年和阶段分类；没有具体发生日期也保留分类。新活动统一发布后更新正式时长。'}</p>
  </section>;
}
