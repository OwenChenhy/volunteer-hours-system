import { useSession } from './SessionContext';
import { useRef, useState } from 'react';
import { searchStudent, updateProblemLog } from './api';

const terms = { upper: '上半年', lower: '下半年', vacation: '寒暑假补录', unassigned: '待确认累计' };
const hours = (n) => Number(n || 0).toFixed(1);
const legacyLabel = '2026年10月之前导入的活动';

export default function StudentLookupPage() {
  const [mode, setMode] = useState('student_id');
  const [value, setValue] = useState('');
  const [other, setOther] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(null);
  const [scopeYear, setScopeYear] = useState('');
  const [scopeTerm, setScopeTerm] = useState('');
  const queryId = useRef(0);
  const { can } = useSession();
  const canEdit = can('reviews:manage');
  const canEditResult = canEdit && result?.query_read_only === false;

  async function load(page = 1) {
    const id = ++queryId.current;
    setEditing(null); setResult(null); setError(''); setLoading(true);
    try {
      const nextResult = await searchStudent(mode, value.trim(), other.trim(), page);
      if (queryId.current === id) setResult(nextResult);
    }
    catch (err) { if (queryId.current === id) { setResult(null); setError(err.message); } }
    finally { if (queryId.current === id) setLoading(false); }
  }
  async function save(event) {
    event.preventDefault();
    if (!editing || !canEditResult) {
      setEditing(null); setError('公示版本仅供核对，请按学号或姓名查询当前审核记录后更正。');
      return;
    }
    setError(''); setLoading(true);
    try {
      const updated = await updateProblemLog(editing.id, {
        student_id: editing.student_id, student_name: editing.student_name, college: editing.college, grade: editing.grade,
        activity_name: editing.activity_name, activity_date: editing.activity_date,
        academic_year: editing.academic_year, academic_term: editing.academic_term,
        hours: Number(editing.hours), note: editing.note, sync_student_info: editing.sync_student_info,
      });
      if (mode === 'student_id') setValue(updated.student_id);
      if (mode === 'student_name') setValue(updated.student_name);
      setOther(''); setEditing(null); setResult(null); setMessage('修改已保存。请按更新后的学号或姓名查询；正式时长将在统一发布后更新。');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  const years = [...new Set((result?.matches || []).flatMap((student) => (student.academic_summaries || []).map((s) => s.academic_year)).filter(Boolean))].sort().reverse();
  return <section className="dashboard-section">
    <h2>学生查找与时长修改</h2><p>姓名查询会显示所有匹配人员，结合学号、学院和年级核对；可同时填写另一项缩小范围。</p>
    {error && <p role="alert" className="academic-error">{error}</p>}{message && <p role="status">{message}</p>}
    <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setEditing(null); load(1); }}>
      <select aria-label="查询方式" value={mode} onChange={(e) => { queryId.current += 1; setMode(e.target.value); setOther(''); setResult(null); setEditing(null); setError(''); setLoading(false); }}><option value="student_id">学号</option><option value="student_name">姓名</option><option value="verification_code">校验码</option></select>
      <input aria-label="查询内容" required value={value} onChange={(e) => setValue(e.target.value)} placeholder="查询内容" />
      {mode !== 'verification_code' && <input aria-label="联合查询条件" value={other} onChange={(e) => setOther(e.target.value)} placeholder={mode === 'student_id' ? '姓名（可选）' : '学号（可选）'} />}
      <button disabled={loading} type="submit">{loading ? '处理中' : '查询'}</button>
      <select aria-label="活动学年筛选" value={scopeYear} onChange={(e) => setScopeYear(e.target.value)}><option value="">全部范围</option>{years.map((year) => <option key={year} value={year}>{year === 'legacy' ? legacyLabel : year}</option>)}</select>
      <select aria-label="活动阶段筛选" value={scopeTerm} onChange={(e) => setScopeTerm(e.target.value)}><option value="">全部阶段</option>{Object.entries(terms).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </form>
    {editing && canEditResult && <form className="form-grid academic-editor" onSubmit={save}>
      <h3>更正记录</h3>
      {Object.entries({ student_id: '学号', student_name: '姓名', college: '学院', grade: '年级', activity_name: '活动名称', academic_year: '学年（历史导入可留空）' }).map(([key, label]) => <label key={key}>{label}<input required={['student_id', 'student_name', 'activity_name'].includes(key)} value={editing[key] || ''} onChange={(e) => setEditing({ ...editing, [key]: e.target.value })} /></label>)}
      <label>活动日期<input type="date" required={!editing.historical} value={editing.activity_date || ''} onChange={(e) => setEditing({ ...editing, activity_date: e.target.value })} /><small>历史活动未提供发生日期，可留空。</small></label>
      <label>归属阶段<select value={editing.academic_term} onChange={(e) => setEditing({ ...editing, academic_term: e.target.value })}>{Object.entries(terms).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>更正后的时长<input type="number" step="0.1" min="-9999.9" max="9999.9" required value={editing.hours} onChange={(e) => setEditing({ ...editing, hours: e.target.value })} /><small>0表示作废该项时长；负数表示扣减调整。</small></label>
      <label>修改原因<textarea required value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></label>
      <label className="inline-check"><input type="checkbox" checked={editing.sync_student_info} onChange={(e) => setEditing({ ...editing, sync_student_info: e.target.checked })} />姓名、学号、学院、年级同步到此人的其他记录</label>
      <div><button disabled={loading} type="submit">保存修改</button><button type="button" onClick={() => setEditing(null)}>取消</button></div>
    </form>}
    {result && <>{result.query_read_only && <p role="status">当前显示已公示的冻结版本，仅供核对。更正请按学号或姓名查询当前审核记录。</p>}<p>匹配 {result.total_matches} 人 · 第 {result.page || 1} 页</p>{result.matches.map((student) => <section className="lookup-result" key={`${student.student_id}-${student.student_name}`}>
      <h3>{student.student_name} · {student.student_id}</h3><p>{student.college || '未填写学院'} · {student.grade || '未填写年级'} · 净累计 {hours(student.total_hours)} 小时</p>
      <div className="table-wrap"><table className="data-table"><thead><tr>{['活动', '日期', '学年', '归属', '时长', '操作'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {(student.records || []).filter((row) => (!scopeYear || row.academic_year === scopeYear) && (!scopeTerm || row.academic_term === scopeTerm)).map((row) => <tr key={row.id || row.activity_code}><td>{row.activity_name}</td><td>{row.activity_time_label || row.activity_date || legacyLabel}</td><td>{row.academic_year === 'legacy' ? '历史导入' : row.academic_year || '待确认'}</td><td>{terms[row.academic_term] || '待确认'}</td><td>{hours(row.hours)}</td><td>{canEditResult && row.id && <button type="button" onClick={() => setEditing({ ...row, ...student, ...row, historical: !row.activity_date, academic_year: row.academic_year === 'legacy' ? '' : row.academic_year, student_id: student.student_id, student_name: student.student_name, college: student.college || '', grade: student.grade || '', note: '', sync_student_info: true })}>修改</button>}</td></tr>)}
      </tbody></table></div>
    </section>)}<div className="toolbar"><button disabled={loading || (result.page || 1) <= 1} onClick={() => load(result.page - 1)}>上一页</button><button disabled={loading || !result.truncated} onClick={() => load((result.page || 1) + 1)}>下一页</button></div></>}
  </section>;
}
