import { useEffect, useState } from 'react';
import { getAcademicSummary } from './api';

const hours = (n) => Number(n || 0).toFixed(1);
function currentYear() { const now = new Date(); const year = now.getFullYear() - (now.getMonth() < 8 ? 1 : 0); return `${year}-${year + 1}`; }

export default function AcademicSummaryPage() {
  const [form, setForm] = useState({ academic_year: currentYear(), college: '', grade: '' });
  const [scope, setScope] = useState(form);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    getAcademicSummary({ ...scope, page, limit: 50 }).then((value) => { if (alive) setData(value); }).catch((err) => { if (alive) { setError(err.message); setData(null); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, page, refresh]);
  return <section className="dashboard-section">
    <h2>学年时长汇总表</h2><p>每人一行，按净志愿时长降序；相同时长并列排名。学院管理员仅查看所属学院。</p>
    <form className="toolbar" onSubmit={(event) => { event.preventDefault(); setScope({ ...form }); setPage(1); }}>
      <label>学年 <input aria-label="汇总学年" pattern="20[0-9]{2}-20[0-9]{2}" required value={form.academic_year} onChange={(e) => setForm({ ...form, academic_year: e.target.value })} /></label>
      <label>学院 <input aria-label="汇总学院" placeholder="全部学院" value={form.college} onChange={(e) => setForm({ ...form, college: e.target.value })} /></label>
      <label>年级 <input aria-label="汇总年级" placeholder="例如25级，留空为全部" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></label>
      <button type="submit" disabled={loading}>查询汇总</button><button type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>刷新</button>
    </form>
    {error && <p role="alert" className="academic-error">{error}</p>}
    <div className="table-wrap"><table className="data-table"><thead><tr>{['排名', '学号', '姓名', '学院', '年级', '上半年', '下半年', '寒暑假补录', '待确认累计', '净总时长'].map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{data?.rows.map((row) => <tr key={`${row.student_id}-${row.student_name}-${row.college}-${row.grade}`}><td>{row.rank}</td><td>{row.student_id}</td><td>{row.student_name}</td><td>{row.college || '未填写'}</td><td>{row.grade || '未填写'}</td>{['upper_hours', 'lower_hours', 'vacation_hours', 'unassigned_hours', 'total_hours'].map((field) => <td key={field}>{hours(row[field])}</td>)}</tr>)}</tbody></table>
      {!loading && data?.rows.length === 0 && <p>当前学年和筛选范围没有已审核记录。</p>}
    </div>
    <div className="toolbar"><span>共 {data?.total_students || 0} 人 · 第 {page} 页</span><button disabled={loading || page === 1} onClick={() => setPage((n) => n - 1)}>上一页</button><button disabled={loading || !data || page * 50 >= data.total_students} onClick={() => setPage((n) => n + 1)}>下一页</button></div>
    <p>未提供可靠活动期间的历史累计项列入“待确认累计”，确认归属后再进入对应阶段。各阶段之和等于净总时长。</p>
  </section>;
}
