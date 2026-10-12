import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AcademicSummary from './AcademicSummary';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const ALL = 'all';

const SOURCE_LABELS = {
  online: '在线记录',
  imported: '导入记录',
  import: '导入记录',
  manual: '人工录入',
  unknown: '未知来源'
};

const LEGACY_PLACEHOLDER_PATTERN = /(源表|未拆分|拆分时长|拆分明细|已拆分|累计未拆分)/;

const SORT_OPTIONS = [
  { value: 'time_desc', label: '时间说明：新到旧' },
  { value: 'time_asc', label: '时间说明：旧到新' },
  { value: 'hours_desc', label: '服务时长：高到低' },
  { value: 'hours_asc', label: '服务时长：低到高' },
  { value: 'name_asc', label: '活动名称：A-Z' }
];

const GROUP_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'source', label: '按数据来源' },
  { value: 'time', label: '按时间说明' }
];

function normalizeResult(data) {
  const student = data.student || data;
  const records = Array.isArray(data.records) ? data.records : [];
  const dataVersion = data.data_version || data.dataVersion || student.data_version || null;

  return {
    student: {
      student_id: student.student_id || '',
      student_name: student.student_name || '',
      college: student.college || '未填写',
      grade: student.grade || '未填写'
    },
    academic_summaries: data.academic_summaries || [],
    review_progress: data.review_progress || [],
    total_hours: Number(data.total_hours || student.total_hours || 0),
    data_version: dataVersion,
    verification_code: data.verification_code || data.verificationCode || student.verification_code || '',
    records: records.map((record, index) => normalizeRecord(record, index))
  };
}

function normalizeRecord(record, index) {
  const source = record.source || 'unknown';
  const activityName = sanitizePublicText(record.activity_name, '累计时长记录');
  const activityPeriod = sanitizePublicText(record.activity_period, '');
  const rawTime = sanitizePublicText(record.activity_time_label || activityPeriod || record.activity_date || '', '累计记录');
  const isSummaryRecord = Boolean(record.is_summary_record) || isLegacyPlaceholder(record.activity_name) || isLegacyPlaceholder(record.activity_period);
  const timeScope = activityPeriod === '2026年10月之前导入的活动' ? '历史导入' : isSummaryRecord
    ? '累计记录'
    : activityPeriod
      ? '记录周期'
    : record.activity_date
      ? '活动日期'
      : '未标明';

  return {
    ...record,
    _id: `${activityName || 'record'}-${rawTime || index}-${index}`,
    activity_code: record.activity_code || `HD-${String(index + 1).padStart(3, '0')}`,
    activity_name: activityName || '-',
    activity_date: record.activity_date || '',
    activity_period: activityPeriod || '',
    activity_time_label: rawTime || '-',
    hours: Number(record.hours || 0),
    source,
    source_label: record.source_label || SOURCE_LABELS[source] || SOURCE_LABELS.unknown,
    time_scope: timeScope,
    time_note: sanitizePublicText(record.time_note, '') || getTimeNote(timeScope),
    detail_status: record.detail_status || record.import_detail_status || ''
  };
}

function sanitizePublicText(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return isLegacyPlaceholder(text) ? fallback : text;
}

function isLegacyPlaceholder(value) {
  return LEGACY_PLACEHOLDER_PATTERN.test(String(value || '').trim());
}

function formatHours(value) {
  const hours = Number(value || 0);
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getVersionTitle(version) {
  if (!version) return '暂无数据版本';
  return version.source_name || version.note || version.filename || '未命名批次';
}

function getBatchId(version) {
  if (!version?.batch_id) return '暂无';
  return String(version.batch_id).slice(0, 8).toUpperCase();
}

function getTimeNote(scope) {
  if (scope === '历史导入') return '2026年10月之前导入的活动，未提供可靠发生日期。';
  if (scope === '累计记录') {
    return '该记录为累计项，未提供单独活动名称或发生日期。';
  }
  if (scope === '记录周期') {
    return '该记录展示的是活动所属栏目、学期或公示周期，不代表活动真实发生日期。';
  }
  if (scope === '活动日期') {
    return '由提交人或导入文件提供的活动发生日期；导入时间由系统单独记录。';
  }
  return '来源数据未提供可展示的时间说明。';
}

function getSearchText(record) {
  return [
    record.activity_name,
    record.activity_time_label,
    record.activity_period,
    record.activity_date,
    record.source_label,
    record.detail_status
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true });
}

function compareRecords(left, right, sortBy) {
  if (sortBy === 'time_asc') {
    return compareText(left.activity_time_label, right.activity_time_label);
  }
  if (sortBy === 'hours_desc') {
    return right.hours - left.hours || compareText(left.activity_name, right.activity_name);
  }
  if (sortBy === 'hours_asc') {
    return left.hours - right.hours || compareText(left.activity_name, right.activity_name);
  }
  if (sortBy === 'name_asc') {
    return compareText(left.activity_name, right.activity_name);
  }
  return compareText(right.activity_time_label, left.activity_time_label);
}

function getGroupLabel(record, groupBy) {
  if (groupBy === 'source') return record.source_label;
  if (groupBy === 'time') return record.activity_time_label || '未标明时间说明';
  return '全部活动';
}

function buildGroups(records, groupBy) {
  if (groupBy === 'none') {
    return [{ label: '全部活动', records }];
  }

  return records.reduce((groups, record) => {
    const label = getGroupLabel(record, groupBy);
    const group = groups.find((item) => item.label === label);
    if (group) {
      group.records.push(record);
    } else {
      groups.push({ label, records: [record] });
    }
    return groups;
  }, []);
}

function getMessageDetail(message) {
  if (message.includes('未查到')) {
    return '请确认输入信息与公示数据完全一致；如仍未查到，可等待下一批次更新或联系学院核对。';
  }
  if (message.includes('频繁')) {
    return '请稍后再试，避免短时间内重复提交查询。';
  }
  return '请稍后重试；若问题持续存在，请联系管理员核对当前查询服务状态。';
}

function App() {
  const [studentId, setStudentId] = useState('');
  const [studentName, setStudentName] = useState('');
  const [result, setResult] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [sourceFilter, setSourceFilter] = useState(ALL);
  const [timeFilter, setTimeFilter] = useState(ALL);
  const [sortBy, setSortBy] = useState('time_desc');
  const [groupBy, setGroupBy] = useState('none');

  useEffect(() => {
    let alive = true;

    fetch(`${API_BASE}/api/v1/query/meta`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (alive && data) setDataMeta(data);
      })
      .catch(() => {
        if (alive) setDataMeta(null);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/v1/query/visit`, { method: 'POST' })
      .catch(() => null)
      .then(() => fetch(`${API_BASE}/api/v1/query/metrics`))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (alive && data) setMetrics(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const activeVersion = result?.data_version || dataMeta;

  const sourceOptions = useMemo(() => {
    const map = new Map();
    result?.records.forEach((record) => {
      map.set(record.source, record.source_label);
    });
    return Array.from(map, ([value, label]) => ({ value, label }));
  }, [result]);

  const timeOptions = useMemo(() => {
    const values = new Set();
    result?.records.forEach((record) => {
      if (record.activity_time_label && record.activity_time_label !== '-') {
        values.add(record.activity_time_label);
      }
    });
    return Array.from(values).sort((left, right) => compareText(right, left));
  }, [result]);

  const filteredRecords = useMemo(() => {
    if (!result) return [];
    const normalizedKeyword = keyword.trim().toLowerCase();

    return result.records
      .filter((record) => (sourceFilter === ALL ? true : record.source === sourceFilter))
      .filter((record) => (timeFilter === ALL ? true : record.activity_time_label === timeFilter))
      .filter((record) => (normalizedKeyword ? getSearchText(record).includes(normalizedKeyword) : true))
      .sort((left, right) => compareRecords(left, right, sortBy));
  }, [result, keyword, sourceFilter, timeFilter, sortBy]);

  const groupedRecords = useMemo(() => buildGroups(filteredRecords, groupBy), [filteredRecords, groupBy]);

  function resetDetailControls() {
    setKeyword('');
    setSourceFilter(ALL);
    setTimeFilter(ALL);
    setSortBy('time_desc');
    setGroupBy('none');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const payload = {
      student_id: studentId.trim(),
      student_name: studentName.trim()
    };

    setMessage('');
    setResult(null);
    resetDetailControls();

    if (!payload.student_id || !payload.student_name) {
      setMessage('请输入学号和姓名后再查询。');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('查询过于频繁，请稍后再试。');
        }
        if (response.status === 404) {
          throw new Error('未查到匹配记录。请核对学号和姓名，或联系学院确认是否已提交活动名单。');
        }
        throw new Error(data.message || '查询失败，请稍后再试。');
      }

      setResult(normalizeResult(data));
    } catch (error) {
      setMessage(error.message || '查询失败，请稍后再试。');
    } finally {
      setLoading(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <main className="page-shell">
      <section className="query-panel" aria-labelledby="page-title">
        <div className="query-topline">
          <div className="heading-block">
            <p className="kicker">重庆理工大学</p>
            <h1 id="page-title">志愿时长查询</h1>
            <p className="subtitle">输入本人学号和姓名，查询已发布志愿时长及本人活动审核进度。</p>
          </div>
          <div className="version-card" aria-label="当前数据版本">
            <span>数据版本</span>
            <strong>{getVersionTitle(activeVersion)}</strong>
            <small>批次 {getBatchId(activeVersion)} · 更新 {formatDateTime(activeVersion?.last_updated_at)}</small>
          </div>
        </div>

        <form className="search-form" onSubmit={handleSubmit}>
          <label>
            <span>学号</span>
            <input
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              autoComplete="off"
              inputMode="text"
              placeholder="请输入学号"
            />
          </label>
          <label>
            <span>姓名</span>
            <input
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              autoComplete="name"
              placeholder="请输入姓名"
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? '查询中...' : '查询'}
          </button>
        </form>

        {activeVersion?.precision_note && (
          <p className="data-note">{activeVersion.precision_note}</p>
        )}

        {message && (
          <div className="message" role="status">
            <strong>{message}</strong>
            <span>{getMessageDetail(message)}</span>
          </div>
        )}
      </section>

      {result && (
        <section
          className="result-panel"
          aria-label="查询结果"
          data-watermark={`核验码 ${result.verification_code || '待生成'}`}
        >
          <div className="student-summary">
            <div>
              <p className="summary-label">学生信息</p>
              <h2>{result.student.student_name}</h2>
              <dl>
                <div>
                  <dt>学号</dt>
                  <dd>{result.student.student_id}</dd>
                </div>
                <div>
                  <dt>学院</dt>
                  <dd>{result.student.college}</dd>
                </div>
                <div>
                  <dt>年级</dt>
                  <dd>{result.student.grade}</dd>
                </div>
              </dl>
            </div>
            <div className="total-hours">
              <span>已发布累计时长</span>
              <strong>{formatHours(result.total_hours)}</strong>
              <span>小时</span>
            </div>
          </div>

          <div className="verification-strip">
            <div>
              <span>核验码</span>
              <strong>{result.verification_code || '暂无'}</strong>
            </div>
            <div>
              <span>批次说明</span>
              <strong>{getVersionTitle(result.data_version)}</strong>
            </div>
            <div>
              <span>数据量</span>
              <strong>{result.data_version?.record_count ?? result.records.length} 条</strong>
            </div>
            <button type="button" className="secondary-button" onClick={handlePrint}>
              打印 / 保存 PDF
            </button>
          </div>

          {result.data_version?.note && (
            <p className="batch-note">批次备注：{result.data_version.note}</p>
          )}

          <AcademicSummary result={result} />
          <p className="data-note">正式时长与排名以统一发布的累计库为准。新活动审核完成后统一公示；重新查询可查看本人最新审核进度。</p>
          <section className="academic-summary" aria-label="本人活动审核进度">
            <div className="records-header"><div><h3>本人活动审核进度</h3><p>以下活动尚未计入当前公示时长和排名。</p></div><button type="button" className="secondary-button" disabled={loading} onClick={handleSubmit}>重新查询进度</button></div>
            {result.review_progress.length ? <div className="table-wrap"><table><thead><tr><th>活动</th><th>日期</th><th>申报时长</th><th>审核进度</th><th>说明</th></tr></thead><tbody>{result.review_progress.map((item, index) => <tr key={index}><td>{item.activity_name}</td><td>{item.activity_date}</td><td>{formatHours(item.hours)} 小时</td><td>{item.status_label}</td><td>{item.reject_reason || '等待办公室审核完成后统一发布'}</td></tr>)}</tbody></table></div> : <p>当前没有尚未发布的活动记录。</p>}
          </section>
          <div className="records-header">
            <div>
              <h3>活动明细</h3>
              <p>“活动时间”展示记录周期或公示日期，不作为真实活动发生日期证明。</p>
            </div>
            <span>{filteredRecords.length} / {result.records.length} 条记录</span>
          </div>

          <div className="records-controls" aria-label="明细筛选与排序">
            <label>
              <span>搜索活动</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="活动名称、来源、周期"
                type="search"
              />
            </label>
            <label>
              <span>来源筛选</span>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                <option value={ALL}>全部来源</option>
                {sourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>时间说明</span>
              <select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)}>
                <option value={ALL}>全部时间说明</option>
                {timeOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <span>排序</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>分组</span>
              <select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
                {GROUP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="table-wrap">
            {filteredRecords.length === 0 ? (
              <div className="empty-state">
                <strong>当前筛选条件下没有活动记录</strong>
                <span>请调整活动关键词、来源或时间筛选；查询总结果仍保留在上方汇总中。</span>
              </div>
            ) : (
              groupedRecords.map((group) => (
                <div className="record-group" key={group.label}>
                  {groupBy !== 'none' && (
                    <div className="group-title">
                      <strong>{group.label}</strong>
                      <span>{group.records.length} 条 · {formatHours(group.records.reduce((sum, record) => sum + record.hours, 0))} 小时</span>
                    </div>
                  )}
                  <table>
                    <thead>
                      <tr>
                        <th>活动名称</th>
                        <th>活动编号</th>
                        <th>时间说明</th>
                        <th>服务时长</th>
                        <th>数据来源</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.records.map((record) => (
                        <tr key={record._id}>
                          <td>{record.activity_name}</td>
                          <td><strong>{record.activity_code}</strong></td>
                          <td>
                            <strong className="time-label">{record.activity_time_label}</strong>
                            <span className="time-scope">{record.time_scope}</span>
                          </td>
                          <td>{formatHours(record.hours)} 小时</td>
                          <td>
                            <span className={`source-pill source-${record.source || 'unknown'}`}>
                              {record.source_label}
                            </span>
                          </td>
                          <td className="time-note">{record.time_note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>
        </section>
      )}
<section className="feedback-panel" aria-label="时长问题反馈"><h3>时长或信息有误？</h3><p>请提供学号、姓名、学年、活动名称、应有时长和证明材料，由办公室核对处理。</p>
        {activeVersion?.feedback_email ? <a href={`mailto:${activeVersion.feedback_email}?subject=${encodeURIComponent(`志愿时长核对 ${result?.student.student_id || ''}`)}`}>联系办公室：{activeVersion.feedback_email}</a> : <p>办公室反馈邮箱待配置，请先联系学院负责人。</p>}
      </section>
      <footer className="public-footer">
        <div className="public-metrics" aria-label="站点统计">
          <span>累计访问 <strong>{metrics?.visits?.toLocaleString('zh-CN') ?? '—'}</strong></span>
          <span>成功查询 <strong>{metrics?.queries?.toLocaleString('zh-CN') ?? '—'}</strong></span>
        </div>
        <a href="/status/">系统状态</a>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
