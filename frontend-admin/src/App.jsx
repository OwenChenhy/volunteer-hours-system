import { useEffect, useMemo, useState } from "react";
import AcademicSummaryPage from "./AcademicSummaryPage";
import StudentLookupPage from "./StudentLookupPage";
import PublicationPage from "./PublicationPage";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckSquare,
  ClipboardList,
  Cloud,
  Database,
  FileText,
  HardDrive,
  Home,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  TrendingUp,
  UploadCloud,
  Users,
} from "lucide-react";
import {
  approveLog,
  archiveActivity,
  batchApprove,
  confirmImport,
  createActivity,
  createUser,
  downloadImportTemplate,
  exportStats,
  getOpsStatus,
  getOverview,
  getProblemStats,
  getProblemSourceRow,
  getStatsByCollege,
  getStatsByMonth,
  getStatsRankings,
  listActivities,
  listImportBatches,
  listProblemLogs,
  listLogs,
  listOperationLogs,
  listRoles,
  listUsers,
  login,
  markProcessed,
  previewImport,
  rejectLog,
  resetUserPassword,
  searchStudent,
  submitLogs,
  toggleUser,
  unarchiveActivity,
  updateActivity,
  updateProblemLog,
} from "./api";

const modules = [
  { id: "overview", label: "概览", icon: Home },
  { id: "activities", label: "活动", icon: Activity },
  { id: "lookup", label: "学生查询", icon: Search },
  { id: "academic", label: "学年汇总", icon: BarChart3 },
  { id: "submit", label: "填报", icon: ClipboardList },
  { id: "review", label: "审核", icon: CheckSquare },
  { id: "publication", label: "统一发布", icon: UploadCloud },
  { id: "problems", label: "问题复核", icon: AlertTriangle },
  { id: "import", label: "导入", icon: UploadCloud },
  { id: "stats", label: "统计", icon: BarChart3 },
  { id: "ops", label: "运维状态", icon: Database },
  { id: "users", label: "用户", icon: Users },
  { id: "audit", label: "日志", icon: FileText },
];

const emptyActivity = {
  academic_year: "",
  academic_term: "",
  name: "",
  start_time: "",
  end_time: "",
  location: "",
  org_name: "",
  description: "",
};

const fallbackRoles = [
  { value: "super_admin", label: "超级管理员" },
  { value: "data_admin", label: "数据管理员" },
  { value: "college_admin", label: "学院管理员" },
  { value: "auditor", label: "只读审计员" },
  { value: "admin", label: "管理员" },
  { value: "organizer", label: "活动组织者" },
];

const problemTypeLabels = {
  normal: "正常",
  parsed: "活动明细",
  supplement: "差额补充",
  summary_no_detail: "累计记录",
  summary_conflict: "活动明细冲突待复核",
  reviewed: "已复核确认",
  duplicate_record: "库内重复",
  duplicate_in_file: "同文件重复",
  duplicate_in_request: "同批次重复",
  missing_activity_name: "缺活动名称",
  missing_or_invalid_activity_date: "缺失或无效日期",
  large_hours: "超大时长",
  activity_name_too_long: "活动名超长",
  college_too_long: "学院超长",
  grade_too_long: "年级超长",
  phone_too_long: "联系方式超长",
};

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken"));
  const [activeModule, setActiveModule] = useState("overview");

  useEffect(() => {
    const expire = () => setToken(null);
    window.addEventListener('admin-session-expired', expire);
    return () => window.removeEventListener('admin-session-expired', expire);
  }, []);

  if (!token) {
    return <LoginPage onLogin={setToken} />;
  }

  const ActiveIcon = modules.find((item) => item.id === activeModule)?.icon || Home;

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <ClipboardList size={28} />
          <div>
            <strong>志愿时长</strong>
            <span>管理后台</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="管理后台导航">
          {modules.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={activeModule === item.id ? "nav-item active" : "nav-item"}
                type="button"
                onClick={() => setActiveModule(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <button
          className="logout-button"
          type="button"
          onClick={() => {
            localStorage.removeItem("adminToken");
            setToken(null);
          }}
        >
          <LogOut size={18} />
          <span>退出登录</span>
        </button>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p>志愿时长管理系统</p>
            <h1>{modules.find((item) => item.id === activeModule)?.label}</h1>
          </div>
          <div className="status-pill">
            <ActiveIcon size={16} />
            <span>API 已连接</span>
          </div>
        </header>

        {activeModule === "overview" && <OverviewPage go={setActiveModule} />}
        {activeModule === "activities" && <ActivitiesPage />}
        {activeModule === "lookup" && <StudentLookupPage />}
        {activeModule === "academic" && <AcademicSummaryPage />}
        {activeModule === "submit" && <SubmitPage />}
        {activeModule === "review" && <ReviewPage />}
        {activeModule === "publication" && <PublicationPage />}
        {activeModule === "problems" && <ProblemReviewPage go={setActiveModule} />}
        {activeModule === "import" && <ImportPage />}
        {activeModule === "stats" && <StatsPage go={setActiveModule} />}
        {activeModule === "ops" && <OpsStatusPage />}
        {activeModule === "users" && <UsersPage />}
        {activeModule === "audit" && <AuditPage />}
      </main>
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const data = await login(form);
      const nextToken = data?.access_token;
      if (!nextToken) throw new Error("登录响应缺少访问令牌");
      localStorage.setItem("adminToken", nextToken);
      onLogin(nextToken);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-heading">
          <ClipboardList size={34} />
          <div>
            <p>志愿时长管理系统</p>
            <h1>管理后台登录</h1>
          </div>
        </div>

        <form className="stack-form" onSubmit={handleSubmit}>
          <Field label="账号">
            <input
              autoComplete="username"
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              required
              type="text"
              value={form.username}
            />
          </Field>
          <Field label="密码">
            <input
              autoComplete="current-password"
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              required
              type="password"
              value={form.password}
            />
          </Field>
          <Notice type="error" message={error} />
          <button className="primary-button" disabled={submitting} type="submit">
            <LogIn size={18} />
            <span>{submitting ? "登录中" : "登录"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}

function OverviewPage({ go }) {
  const [overview, setOverview] = useState({});
  const [pending, setPending] = useState([]);
  const [legacy, setLegacy] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [overviewData, pendingRows, legacyRows] = await Promise.all([
        getOverview(),
        listLogs({ status: "pending", limit: 5 }),
        listLogs({ legacy_unprocessed: "true", limit: 5 }),
      ]);
      setOverview(overviewData || {});
      setPending(pendingRows || []);
      setLegacy(legacyRows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const cards = [
    { label: "总学生数", value: overview.total_students ?? 0 },
    { label: "累计时长", value: formatHours(overview.total_hours) },
    { label: "待审核", value: overview.pending_count ?? 0 },
    { label: "未处理导入", value: overview.legacy_todo_count ?? 0 },
    { label: "已通过", value: overview.approved_count ?? 0 },
    { label: "活动数", value: overview.activity_count ?? 0 },
  ];

  return (
    <section className="dashboard-section">
      <SectionTitle title="运行概览" subtitle={loading ? "正在加载" : "实时读取后台数据"} onRefresh={load} />
      <Notice type="error" message={error} />
      <div className="metric-grid">
        {cards.map((card) => (
          <article className="metric-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>
      <Panel title="重点工作入口">
        <div className="quick-grid">
          <button className="quick-action" type="button" onClick={() => go("problems")}>
            <AlertTriangle size={18} />
            <span>问题数据复核</span>
          </button>
          <button className="quick-action" type="button" onClick={() => go("import")}>
            <UploadCloud size={18} />
            <span>导入预览确认</span>
          </button>
          <button className="quick-action" type="button" onClick={() => go("stats")}>
            <TrendingUp size={18} />
            <span>增强统计报表</span>
          </button>
          <button className="quick-action" type="button" onClick={() => go("ops")}>
            <ShieldCheck size={18} />
            <span>备份监控状态</span>
          </button>
        </div>
      </Panel>
      <div className="two-column">
        <Panel title="待审核记录" action={<button onClick={() => go("review")}>进入审核</button>}>
          <CompactLogList rows={pending} />
        </Panel>
        <Panel title="未处理导入" action={<button onClick={() => go("problems")}>进入复核</button>}>
          <CompactLogList rows={legacy} />
        </Panel>
      </div>
    </section>
  );
}

function ActivitiesPage() {
  const [academicFilter, setAcademicFilter] = useState({ year: "", term: "" });
  const [activities, setActivities] = useState([]);
  const [form, setForm] = useState(emptyActivity);
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      setActivities(await listActivities());
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    try {
      const payload = activityPayload(form);
      if (editingId) {
        await updateActivity(editingId, payload);
        setMessage("活动已更新");
      } else {
        await createActivity(payload);
        setMessage("活动已创建");
      }
      setForm(emptyActivity);
      setEditingId("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function edit(activity) {
    setEditingId(activity.id);
    setForm({
      historical: !activity.start_time,
      academic_year: activity.academic_year_inferred ? "" : activity.academic_year || "",
      academic_term: activity.academic_term_inferred ? "" : activity.academic_term || "",
      name: activity.name || "",
      start_time: toLocalInput(activity.start_time),
      end_time: toLocalInput(activity.end_time),
      location: activity.location || "",
      org_name: activity.org_name || "",
      description: activity.description || "",
    });
  }

  async function toggleArchive(activity) {
    setError("");
    try {
      if (activity.status === "archived") {
        await unarchiveActivity(activity.id);
      } else {
        await archiveActivity(activity.id);
      }
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="dashboard-section">
      <SectionTitle title="活动管理" subtitle="创建、编辑和归档活动" onRefresh={load} />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />

      <Panel title={editingId ? "编辑活动" : "创建活动"}>
        <form className="form-grid" onSubmit={save}>
          <Field label="活动名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="开始时间"><input type="datetime-local" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required={!form.historical} /></Field>
          <Field label="结束时间"><input type="datetime-local" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required={!form.historical} /></Field>
          <Field label="地点"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
          <Field label="学年（留空按日期归类）"><input value={form.academic_year} onChange={(e) => setForm({ ...form, academic_year: e.target.value })} placeholder="2025-2026" /></Field>
          <Field label="阶段"><select value={form.academic_term} onChange={(e) => setForm({ ...form, academic_term: e.target.value })}><option value="">按月份自动归类</option><option value="upper">上半年</option><option value="lower">下半年</option><option value="vacation">寒暑假补录</option></select></Field>
          <Field label="负责单位"><input value={form.org_name} onChange={(e) => setForm({ ...form, org_name: e.target.value })} /></Field>
          <Field label="描述"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="form-actions">
            <button className="primary-button" type="submit"><Save size={16} />保存</button>
            {editingId && <button type="button" onClick={() => { setEditingId(""); setForm(emptyActivity); }}>取消编辑</button>}
          </div>
        </form>
      </Panel>

      <div className="toolbar"><label>学年 / 历史范围 <select value={academicFilter.year} onChange={(e) => setAcademicFilter({ ...academicFilter, year: e.target.value })}><option value="">全部范围</option>{[...new Set(activities.map((a) => a.academic_year).filter(Boolean))].sort().reverse().map((year) => <option key={year} value={year}>{year === 'legacy' ? '2026年10月之前导入的活动' : year}</option>)}</select></label><label>阶段 <select value={academicFilter.term} onChange={(e) => setAcademicFilter({ ...academicFilter, term: e.target.value })}><option value="">全部阶段</option><option value="unassigned">历史累计 / 未分期</option><option value="upper">上半年</option><option value="lower">下半年</option><option value="vacation">寒暑假补录</option></select></label></div>
      <Panel title="活动列表">
        <DataTable
          columns={["名称", "学年", "阶段", "时间", "地点", "单位", "状态", "操作"]}
          rows={activities.filter((a) => (!academicFilter.year || a.academic_year === academicFilter.year) && (!academicFilter.term || a.academic_term === academicFilter.term)).map((activity) => [
            activity.name,
            activity.academic_year === "legacy" ? "历史导入" : activity.academic_year || "待确认",
            activity.term_label || "待确认",
            activity.start_time ? `${formatDateTime(activity.start_time)} - ${formatDateTime(activity.end_time)}` : "2026年10月之前导入的活动",
            activity.location || "-",
            activity.org_name || "-",
            <Badge key="status" tone={activity.status === "archived" ? "muted" : "green"}>{activity.status === "archived" ? "已归档" : "进行中"}</Badge>,
            <div className="row-actions" key="actions">
              <button onClick={() => edit(activity)}>编辑</button>
              <button onClick={() => toggleArchive(activity)}>{activity.status === "archived" ? "恢复" : "归档"}</button>
            </div>,
          ])}
        />
      </Panel>
    </section>
  );
}

function SubmitPage() {
  const [activities, setActivities] = useState([]);
  const [activityId, setActivityId] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    listActivities().then((rows) => {
      const active = rows.filter((item) => item.status !== "archived");
      setActivities(active);
      setActivityId(active[0]?.id || "");
    }).catch((err) => setError(err.message));
  }, []);

  function parse() {
    const rows = pasteText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\t|,|，/).map((part) => part.trim());
        return {
          student_id: parts[0] || "",
          student_name: parts[1] || "",
          college: parts[2] || "",
          grade: parts[3] || "",
          hours: Number(parts[4] || 0),
          phone: parts[5] || "",
        };
      });
    setPreview(rows);
  }

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    const records = preview.length ? preview : [];
    if (!activityId) return setError("请选择活动");
    if (!records.length) return setError("请先解析粘贴数据");
    if (records.some((row) => !row.student_id || !row.student_name || !row.hours || row.hours <= 0)) {
      return setError("存在缺学号、姓名或有效时长的记录");
    }
    try {
      await submitLogs({ activity_id: activityId, records });
      setMessage(`已提交 ${records.length} 条记录，等待审核`);
      setPasteText("");
      setPreview([]);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="dashboard-section">
      <SectionTitle title="时长填报" subtitle="支持从 Excel 复制粘贴，列顺序：学号、姓名、学院、年级、时长、联系方式" />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />
      <Panel title="批量提交">
        <form className="stack-form" onSubmit={submit}>
          <Field label="关联活动">
            <select value={activityId} onChange={(e) => setActivityId(e.target.value)} required>
              {activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}
            </select>
          </Field>
          <Field label="粘贴表格">
            <textarea
              rows={8}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"TEST-STUDENT-003\t测试用户\t计算机科学与工程学院\t25级\t2.5\tTEST-PHONE"}
            />
          </Field>
          <div className="form-actions">
            <button type="button" onClick={parse}>解析预览</button>
            <button className="primary-button" type="submit"><Plus size={16} />提交填报</button>
          </div>
        </form>
      </Panel>
      <Panel title={`预览 ${preview.length} 条`}>
        <DataTable
          columns={["学号", "姓名", "学院", "年级", "时长", "联系方式"]}
          rows={preview.map((row) => [row.student_id, row.student_name, row.college, row.grade, formatHours(row.hours), row.phone])}
        />
      </Panel>
    </section>
  );
}

function ReviewPage() {
  const [filters, setFilters] = useState({ status: "pending", source: "", legacy_unprocessed: "" });
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      setLogs(await listLogs({ ...filters, limit: 500 }));
      setSelected([]);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action, success) {
    setMessage("");
    setError("");
    try {
      await action();
      setMessage(success);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="dashboard-section">
      <SectionTitle title="审核管理" subtitle="审核在线填报，处理导入记录" onRefresh={load} />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />
      <Panel title="筛选">
        <div className="toolbar">
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">全部状态</option>
            <option value="pending">待审核</option>
            <option value="approved">已通过</option>
            <option value="rejected">已驳回</option>
          </select>
          <select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
            <option value="">全部来源</option>
            <option value="online">在线记录</option>
            <option value="imported">导入记录</option>
          </select>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={filters.legacy_unprocessed === "true"}
              onChange={(e) => setFilters({ ...filters, legacy_unprocessed: e.target.checked ? "true" : "" })}
            />
            只看未处理导入
          </label>
          <button onClick={load}>查询</button>
          <button disabled={!selected.length} onClick={() => run(() => batchApprove(selected), `已批量通过 ${selected.length} 条`)}>
            批量通过
          </button>
        </div>
      </Panel>
      <Panel title={`记录列表 ${logs.length} 条`}>
        <DataTable
          columns={["选择", "学生", "活动", "日期", "时长", "来源", "状态", "操作"]}
          rows={logs.map((log) => [
            <input
              key="check"
              type="checkbox"
              checked={selected.includes(log.id)}
              onChange={(e) => setSelected(e.target.checked ? [...selected, log.id] : selected.filter((id) => id !== log.id))}
            />,
            `${log.student_name} / ${log.student_id}`,
            log.activity_name,
            log.activity_date ? formatDate(log.activity_date) : log.activity_period || "2026年10月之前导入的活动",
            formatHours(log.hours),
            <Badge key="source" tone={log.source === "imported" ? "orange" : "green"}>{log.source === "imported" ? "导入" : "在线"}</Badge>,
            <StatusBadge key="status" status={log.status} />,
            <div className="row-actions" key="actions">
              {log.status === "pending" && <button onClick={() => run(() => approveLog(log.id), "已通过")}>通过</button>}
              {log.status === "pending" && <button onClick={() => {
                const reason = window.prompt("请输入驳回原因", "信息有误，请重新核实");
                if (reason) run(() => rejectLog(log.id, reason), "已驳回");
              }}>驳回</button>}
              {log.source === "imported" && !log.is_legacy_processed && <button onClick={() => run(() => markProcessed(log.id), "已标记处理")}>标记已处理</button>}
            </div>,
          ])}
        />
      </Panel>
    </section>
  );
}

function ProblemReviewPage({ go }) {
  const [filters, setFilters] = useState({ problemType: "", processed: "todo", keyword: "" });
  const [logs, setLogs] = useState([]);
  const [problemStats, setProblemStats] = useState({ by_status: [], trend: [] });
  const [sourceReview, setSourceReview] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [reviewForm, setReviewForm] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const [rows, stats] = await Promise.all([
        listProblemLogs({ type: filters.problemType || "all", keyword: filters.keyword, limit: 1000 }),
        getProblemStats().catch(() => ({ by_status: [], trend: [] })),
      ]);
      setLogs(rows || []);
      setProblemStats(stats || { by_status: [], trend: [] });
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action, success) {
    setMessage("");
    setError("");
    try {
      await action();
      setMessage(success);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function confirmProblem(row) {
    const noteText = window.prompt("复核备注", "已确认该问题数据可按当前记录展示");
    if (noteText === null) return;
    await run(
      () => updateProblemLog(row.id, { note: noteText, mark_processed: true }),
      "已保存复核确认"
    );
  }

  function buildReviewForm(row) {
    return {
      student_id: row.student_id || "",
      student_name: row.student_name || "",
      college: row.college || "",
      grade: row.grade || "",
      phone: row.phone || "",
      activity_name: row.activity_name || "",
      activity_period: row.activity_period || "",
      activity_date: formatInputDate(row.activity_date),
      hours: row.hours ?? "",
      source_total_hours: row.source_total_hours ?? "",
      note: "管理员根据 Excel 原始记录复核修正",
      mark_processed: true,
    };
  }

  async function openSourceReview(row) {
    setMessage("");
    setError("");
    setSourceLoading(true);
    setSourceReview({ row, source: null });
    setReviewForm(buildReviewForm(row));
    try {
      const source = await getProblemSourceRow(row.id);
      setSourceReview({ row, source });
    } catch (err) {
      setError(err.message);
      setSourceReview({ row, source: null });
    } finally {
      setSourceLoading(false);
    }
  }

  async function saveSourceReview(event) {
    event.preventDefault();
    if (!sourceReview?.row || !reviewForm) return;
    await run(
      () => updateProblemLog(sourceReview.row.id, {
        student_id: reviewForm.student_id,
        student_name: reviewForm.student_name,
        college: reviewForm.college,
        grade: reviewForm.grade,
        phone: reviewForm.phone,
        activity_name: reviewForm.activity_name,
        activity_period: reviewForm.activity_period,
        activity_date: reviewForm.activity_date,
        hours: Number(reviewForm.hours),
        source_total_hours: reviewForm.source_total_hours === "" ? undefined : Number(reviewForm.source_total_hours),
        note: reviewForm.note,
        mark_processed: reviewForm.mark_processed,
        sync_activity: true,
      }),
      "已根据原始 Excel 记录保存复核修改"
    );
    setSourceReview(null);
    setReviewForm(null);
  }

  const problemRows = useMemo(() => logs.filter(isProblemDataRow), [logs]);
  const statusRows = useMemo(
    () => normalizeProblemStatusRows(problemStats).filter((row) => isProblemType(row.problem_type)),
    [problemStats]
  );
  const typeOptions = useMemo(() => {
    const values = new Set([
      ...problemRows.map(getRowProblemType),
      ...statusRows.map((row) => row.problem_type),
    ]);
    return [...values]
      .filter((value) => value && value !== "normal" && value !== "parsed")
      .sort((a, b) => problemTypeLabel(a).localeCompare(problemTypeLabel(b), "zh-CN"));
  }, [problemRows, statusRows]);
  const visibleRows = useMemo(() => {
    const keyword = filters.keyword.trim().toLowerCase();
    return problemRows.filter((row) => {
      const type = getRowProblemType(row);
      const processed = row.is_legacy_processed === true;
      const matchesType = !filters.problemType || type === filters.problemType;
      const matchesProcessed =
        filters.processed === "" ||
        (filters.processed === "done" ? processed : !processed);
      const text = [
        row.student_id,
        row.student_name,
        row.college,
        row.activity_name,
        row.activity_period,
        row.source_file,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesType && matchesProcessed && (!keyword || text.includes(keyword));
    });
  }, [filters, problemRows]);

  const todoCount = problemRows.filter((row) => row.is_legacy_processed !== true).length;
  const conflictCount = problemRows.filter((row) => getRowProblemType(row) === "summary_conflict").length;

  return (
    <section className="dashboard-section">
      <SectionTitle title="问题数据复核中心" subtitle="集中复核导入明细拆分、差额补充和冲突累计记录" onRefresh={load} />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />

      <div className="metric-grid">
        <Metric label="待复核问题" value={problemRows.length} />
        <Metric label="未标记处理" value={todoCount} />
        <Metric label="冲突累计" value={conflictCount} />
        <Metric label="当前展示" value={visibleRows.length} />
      </div>

      <Panel title="问题状态分布" action={<button type="button" onClick={() => go("import")}><UploadCloud size={16} />去导入</button>}>
        <DataTable
          columns={["问题状态", "记录数", "总时长"]}
          rows={statusRows.map((row) => [
            <Badge key="type" tone={problemTone(row.problem_type)}>{problemTypeLabel(row.problem_type)}</Badge>,
            row.record_count,
            formatHours(row.total_hours),
          ])}
        />
      </Panel>

      <Panel title="筛选">
        <div className="toolbar">
          <select value={filters.problemType} onChange={(e) => setFilters({ ...filters, problemType: e.target.value })}>
            <option value="">全部问题类型</option>
            {typeOptions.map((type) => (
              <option key={type} value={type}>{problemTypeLabel(type)}</option>
            ))}
          </select>
          <select value={filters.processed} onChange={(e) => setFilters({ ...filters, processed: e.target.value })}>
            <option value="todo">未处理</option>
            <option value="done">已处理</option>
            <option value="">全部</option>
          </select>
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索问题数据"
              placeholder="学号、姓名、学院或活动"
              value={filters.keyword}
              onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
            />
          </div>
          <button type="button" onClick={load}>查询</button>
        </div>
      </Panel>

      {sourceReview && reviewForm && (
        <Panel
          title="原始记录与复核编辑"
          action={<button type="button" onClick={() => { setSourceReview(null); setReviewForm(null); }}>关闭</button>}
        >
          <div className="review-workbench">
            <div className="source-context">
              <strong>{sourceReview.row.student_name || "-"} / {sourceReview.row.student_id || "-"}</strong>
              <span>
                {sourceReview.row.source_file || "-"}
                {sourceReview.row.source_sheet ? ` / ${sourceReview.row.source_sheet}` : ""}
                {sourceReview.row.source_row ? ` #${sourceReview.row.source_row}` : ""}
              </span>
            </div>
            {sourceLoading && <div className="empty-state compact">正在读取原始 Excel 行...</div>}
            {sourceReview.source && (
              <div className="source-grid">
                <div>
                  <h4>Excel 原始行</h4>
                  <DataTable
                    columns={["列", "表头", "原始文本"]}
                    rows={(sourceReview.source.cells || []).map((cell) => [
                      cell.column,
                      cell.header || "-",
                      <span className="raw-cell" key={`${cell.column}-value`}>{cell.value || "-"}</span>,
                    ])}
                  />
                </div>
                <div>
                  <h4>上下文行</h4>
                  <div className="nearby-rows">
                    {(sourceReview.source.nearby_rows || []).map((item) => (
                      <div key={item.row_number} className={item.is_target ? "target" : ""}>
                        <b>#{item.row_number}</b>
                        <span>{(item.values || []).map((cell) => `${cell.column}:${cell.value}`).join(" | ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <form className="form-grid review-form" onSubmit={saveSourceReview}>
              <Field label="学号"><input value={reviewForm.student_id} onChange={(e) => setReviewForm({ ...reviewForm, student_id: e.target.value })} required /></Field>
              <Field label="姓名"><input value={reviewForm.student_name} onChange={(e) => setReviewForm({ ...reviewForm, student_name: e.target.value })} required /></Field>
              <Field label="学院"><input value={reviewForm.college} onChange={(e) => setReviewForm({ ...reviewForm, college: e.target.value })} /></Field>
              <Field label="年级"><input value={reviewForm.grade} onChange={(e) => setReviewForm({ ...reviewForm, grade: e.target.value })} /></Field>
              <Field label="联系方式"><input value={reviewForm.phone} onChange={(e) => setReviewForm({ ...reviewForm, phone: e.target.value })} /></Field>
              <Field label="活动名称"><input value={reviewForm.activity_name} onChange={(e) => setReviewForm({ ...reviewForm, activity_name: e.target.value })} required /></Field>
              <Field label="时间说明"><input value={reviewForm.activity_period} onChange={(e) => setReviewForm({ ...reviewForm, activity_period: e.target.value })} /></Field>
              <Field label="活动日期"><input type="date" value={reviewForm.activity_date} onChange={(e) => setReviewForm({ ...reviewForm, activity_date: e.target.value })} required={Boolean(sourceReview?.log?.activity_date)} /><small>历史活动日期未提供，可留空。</small></Field>
              <Field label="服务时长"><input type="number" step="0.1" min="-9999.9" max="9999.9" value={reviewForm.hours} onChange={(e) => setReviewForm({ ...reviewForm, hours: e.target.value })} required /></Field>
              <Field label="源表总时长"><input type="number" step="0.1" min="0.1" value={reviewForm.source_total_hours} onChange={(e) => setReviewForm({ ...reviewForm, source_total_hours: e.target.value })} /></Field>
              <Field label="复核备注"><textarea rows={3} value={reviewForm.note} onChange={(e) => setReviewForm({ ...reviewForm, note: e.target.value })} /></Field>
              <label className="field checkbox-field">
                <span>处理状态</span>
                <input type="checkbox" checked={reviewForm.mark_processed} onChange={(e) => setReviewForm({ ...reviewForm, mark_processed: e.target.checked })} />
                <em>保存后标记为已处理</em>
              </label>
              <div className="form-actions">
                <button type="submit" className="primary-button"><Save size={16} />保存复核修改</button>
                <button type="button" onClick={() => confirmProblem(sourceReview.row)}>仅确认当前记录</button>
              </div>
            </form>
          </div>
        </Panel>
      )}

      <Panel title={`复核列表 ${visibleRows.length} 条`}>
        <DataTable
          columns={["处理", "问题", "学生", "学院", "活动", "时间", "时长", "原始行", "操作"]}
          rows={visibleRows.map((row) => [
            <Badge key="processed" tone={row.is_legacy_processed ? "green" : "orange"}>{row.is_legacy_processed ? "已处理" : "待处理"}</Badge>,
            <Badge key="problem" tone={problemTone(getRowProblemType(row))}>{problemTypeLabel(getRowProblemType(row))}</Badge>,
            `${row.student_name || "-"} / ${row.student_id || "-"}`,
            row.college || "-",
            row.activity_name || "-",
            row.activity_period || formatDate(row.activity_date),
            formatHours(row.hours),
            row.source_file ? `${row.source_file}${row.source_sheet ? ` / ${row.source_sheet}` : ""}${row.source_row ? ` #${row.source_row}` : ""}` : "-",
            <div className="row-actions" key="actions">
              <button type="button" onClick={() => openSourceReview(row)}>原始记录</button>
              <button type="button" onClick={() => confirmProblem(row)}>确认</button>
              {!row.is_legacy_processed && <button type="button" onClick={() => run(() => markProcessed(row.id), "已标记为已复核")}>快速标记</button>}
            </div>,
          ])}
        />
      </Panel>
    </section>
  );
}

function ImportPage() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmedRows, setConfirmedRows] = useState([]);
  const [problemDefaults, setProblemDefaults] = useState({ default_activity_date: "", default_activity_name: "" });
  const [note, setNote] = useState("");
  const [replaceExistingNote, setReplaceExistingNote] = useState(false);
  const [academicDefaults, setAcademicDefaults] = useState({ default_academic_year: "", default_academic_term: "", default_grade: "" });
  const [batches, setBatches] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const confirmedSet = useMemo(() => new Set(confirmedRows), [confirmedRows]);
  const normalRows = useMemo(() => preview?.rows?.filter((row) => row.status === "ok") || [], [preview]);
  const problemRows = useMemo(() => preview?.rows?.filter((row) => row.status === "warning") || [], [preview]);
  const errorRows = useMemo(() => preview?.rows?.filter((row) => row.status === "error") || [], [preview]);
  const confirmedProblemRows = useMemo(
    () => problemRows.filter((row) => confirmedSet.has(previewRowKey(row))),
    [problemRows, confirmedSet],
  );
  const importableCount = normalRows.length + confirmedProblemRows.length;
  const unconfirmedProblemCount = problemRows.length - confirmedProblemRows.length;
  const diffReport = useMemo(() => buildPreviewDiffReport(preview), [preview]);
  const reimportHints = useMemo(
    () => buildReimportHints(preview, batches, file, note),
    [preview, batches, file, note],
  );

  async function loadBatches() {
    try {
      setBatches(await listImportBatches());
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadBatches();
  }, []);

  async function previewFile(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!file) return setError("请选择 Excel 文件");
    try {
      setPreview(await previewImport(file));
      setConfirmedRows([]);
      setReplaceExistingNote(false);
      setProblemDefaults({ default_activity_date: "", default_activity_name: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleProblemRow(row, checked) {
    setConfirmedRows((current) => {
      const next = new Set(current);
      const key = previewRowKey(row);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return [...next];
    });
  }

  function confirmAllProblems() {
    setConfirmedRows(problemRows.map(previewRowKey));
  }

  async function confirm() {
    setMessage("");
    setError("");
    if (!preview) return;

    try {
      for (const row of confirmedProblemRows) {
        if (rowNeedsDateFallback(row) && !isStrictDate(problemDefaults.default_activity_date)) {
          throw new Error("已确认的问题行存在缺失或无效日期，请填写有效的默认活动日期");
        }
        if (rowNeedsNameFallback(row) && !problemDefaults.default_activity_name.trim()) {
          throw new Error("已确认的问题行存在空活动名称，请填写默认活动名称");
        }
      }

      if (unconfirmedProblemCount > 0) {
        throw new Error(`还有 ${unconfirmedProblemCount} 条问题行未确认，请确认后再导入`);
      }
      if (!preview.preview_id) {
        throw new Error("预览状态缺失，请重新上传文件预览");
      }
      if (importableCount === 0) {
        throw new Error("没有可导入的记录");
      }

      const result = await confirmImport({
        preview_id: preview.preview_id,
        confirmed_row_keys: confirmedProblemRows.map(previewRowKey),
        note,
        default_activity_date: problemDefaults.default_activity_date,
        default_activity_name: problemDefaults.default_activity_name.trim(),
        replace_existing_note: replaceExistingNote,
        ...academicDefaults,
      });
      const skippedErrors = errorRows.length;
      const replaced = result.replaced_record_count
        ? `，替换历史记录 ${result.replaced_record_count} 条`
        : "";
      setMessage(`导入成功：${result.count} 条，跳过重复 ${result.skipped_duplicate_count || 0} 条${result.already_imported ? "（相同文件已导入）" : ""}，确认问题行 ${result.confirmed_problem_count || 0} 条，跳过错误行 ${skippedErrors} 条${replaced}`);
      setPreview(null);
      setFile(null);
      setConfirmedRows([]);
      await loadBatches();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="dashboard-section">
      <SectionTitle title="Excel 导入" subtitle="上传、预览、确认导入历史时长库" onRefresh={loadBatches} />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />
      <div className="two-column">
        <Panel title="上传文件" action={<button onClick={() => downloadImportTemplate().catch((err) => setError(err.message))}>下载模板</button>}>
          <form className="stack-form" onSubmit={previewFile}>
            <Field label="Excel 文件">
              <input accept=".xlsx" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </Field>
<Field label="本批次学年（留空按行内学年或日期归类）"><input placeholder="2025-2026" value={academicDefaults.default_academic_year} onChange={(e) => setAcademicDefaults({ ...academicDefaults, default_academic_year: e.target.value })} /></Field>
            <Field label="本批次归属阶段"><select value={academicDefaults.default_academic_term} onChange={(e) => setAcademicDefaults({ ...academicDefaults, default_academic_term: e.target.value })}><option value="">按行内阶段或日期归类</option><option value="upper">上半年</option><option value="lower">下半年</option><option value="vacation">寒暑假补录</option></select></Field>
            <Field label="缺失年级默认值"><input placeholder="例如25级" value={academicDefaults.default_grade} onChange={(e) => setAcademicDefaults({ ...academicDefaults, default_grade: e.target.value })} /></Field>
            <p>支持多个年级混合导入，按行内年级或年级工作表归类。重复文件和重复活动会跳过；扣减行须在模板中标记“调整”并填写原因。</p>
            <Field label="批次备注">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：2026年4月时长库" />
            </Field>
            <button className="primary-button" type="submit"><UploadCloud size={16} />解析预览</button>
          </form>
        </Panel>
        <Panel title="历史批次">
          <DataTable columns={["文件", "记录数", "备注", "时间"]} rows={batches.map((batch) => [batch.filename, batch.record_count, batch.note || "-", formatDateTime(batch.created_at)])} />
        </Panel>
      </div>

      {preview && (
        <Panel
          title={`预览：共 ${preview.total}，正常 ${preview.ok ?? normalRows.length}，待确认 ${preview.warnings}，错误 ${preview.errors}`}
          action={
            <div className="row-actions">
              {problemRows.length > 0 && <button type="button" onClick={confirmAllProblems}>确认全部问题行</button>}
              {confirmedRows.length > 0 && <button type="button" onClick={() => setConfirmedRows([])}>清空确认</button>}
              <button className="primary-button" disabled={importableCount === 0} onClick={confirm} type="button">
                <CheckSquare size={16} />
                {unconfirmedProblemCount > 0 ? `待确认 ${unconfirmedProblemCount} 条` : `导入 ${importableCount} 条`}
              </button>
            </div>
          }
        >
          <ImportDiffReport report={diffReport} reimportHints={reimportHints} />
          {(
            <label className="inline-check danger-check">
              <input
                type="checkbox"
                checked={replaceExistingNote}
                onChange={(event) => setReplaceExistingNote(event.target.checked)}
              />
              本表为累计表：以固定备注替换同一数据集旧批次（首次导入也需勾选）
            </label>
          )}
          {(problemRows.length > 0 || errorRows.length > 0) && (
            <div className="problem-confirm-panel">
              <div className="problem-summary">
                <Metric label="正常记录" value={normalRows.length} />
                <Metric label="已确认问题行" value={`${confirmedProblemRows.length}/${problemRows.length}`} />
                <Metric label="不可导入错误" value={errorRows.length} />
              </div>
              <div className="form-grid compact">
                <Field label="缺日期默认值">
                  <input
                    type="date"
                    value={problemDefaults.default_activity_date}
                    onChange={(event) => setProblemDefaults({ ...problemDefaults, default_activity_date: event.target.value })}
                  />
                </Field>
                <Field label="缺活动默认值">
                  <input
                    value={problemDefaults.default_activity_name}
                    onChange={(event) => setProblemDefaults({ ...problemDefaults, default_activity_name: event.target.value })}
                    placeholder="例如：历史时长库累计记录"
                  />
                </Field>
              </div>
            </div>
          )}
          <DataTable
            columns={["确认", "工作表", "行", "学号", "姓名", "学院", "年级", "学年", "归属", "活动", "日期", "时长", "状态"]}
            rows={preview.rows.map((row) => [
              row.status === "warning" ? (
                <input
                  aria-label={`确认 ${row.sheet || "工作表"} 第 ${row.row} 行问题数据`}
                  checked={confirmedSet.has(previewRowKey(row))}
                  key="confirm"
                  onChange={(event) => toggleProblemRow(row, event.target.checked)}
                  type="checkbox"
                />
              ) : row.status === "error" ? "不可导入" : "自动",
              row.sheet || "-",
              row.row,
              row.student_id,
              row.student_name,
              row.college,
              row.grade || "待确认",
              academicDefaults.default_academic_year || row.academic_year || "待确认",
              { upper: "上半年", lower: "下半年", vacation: "寒暑假补录", unassigned: "待确认累计" }[academicDefaults.default_academic_term || row.academic_term] || "待确认",
              row.activity_name,
              row.activity_date,
              formatHours(row.hours),
              <IssueCell key="status" row={row} />,
            ])}
          />
        </Panel>
      )}
    </section>
  );
}

function StatsPage({ go }) {
  const [overview, setOverview] = useState({});
  const [college, setCollege] = useState([]);
  const [month, setMonth] = useState([]);
  const [rankings, setRankings] = useState({ students: [], activities: [], colleges: [] });
  const [problemStats, setProblemStats] = useState({ by_status: [], trend: [] });
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const [o, c, m, r, p] = await Promise.all([
        getOverview(),
        getStatsByCollege(),
        getStatsByMonth(),
        getStatsRankings().catch(() => ({ students: [], activities: [], colleges: [] })),
        getProblemStats().catch(() => ({ by_status: [], trend: [] })),
      ]);
      setOverview(o || {});
      setCollege(c || []);
      setMonth(m || []);
      setRankings({
        students: r?.students || [],
        activities: r?.activities || [],
        colleges: r?.colleges || c || [],
      });
      setProblemStats(p || { by_status: [], trend: [] });
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="dashboard-section">
      <SectionTitle title="统计报表" subtitle="全局、排行、问题状态和 Excel 导出" onRefresh={load} />
      <Notice type="error" message={error} />
      <div className="metric-grid">
        <Metric label="总时长" value={formatHours(overview.total_hours)} />
        <Metric label="总学生数" value={overview.total_students ?? 0} />
        <Metric label="总记录数" value={overview.total_records ?? 0} />
        <Metric label="待审核" value={overview.pending_count ?? 0} />
        <Metric label="已通过" value={overview.approved_count ?? 0} />
        <Metric label="已驳回" value={overview.rejected_count ?? 0} />
        <Metric label="未处理导入" value={overview.legacy_todo_count ?? 0} />
        <Metric label="活动数" value={overview.activity_count ?? 0} />
      </div>
      <div className="form-actions">
        <button className="primary-button" onClick={() => exportStats().catch((err) => setError(err.message))}><FileText size={16} />导出 Excel</button>
        <button type="button" onClick={() => go("problems")}><AlertTriangle size={16} />问题复核</button>
      </div>
      <div className="three-column">
        <Panel title="Top 学生">
          <RankList
            rows={rankings.students.slice(0, 8)}
            title={(row) => row.student_name || row.student_id || "-"}
            meta={(row) => `${row.student_id || "-"} / ${row.college || "未填写"}`}
            value={(row) => Number(row.total_hours || 0)}
            suffix="小时"
          />
        </Panel>
        <Panel title="Top 活动">
          <RankList
            rows={rankings.activities.slice(0, 8)}
            title={(row) => row.activity_name || "未命名活动"}
            meta={(row) => `${row.record_count || 0} 条 / ${row.student_count || 0} 人`}
            value={(row) => Number(row.total_hours || 0)}
            suffix="小时"
          />
        </Panel>
        <Panel title="Top 学院">
          <RankList
            rows={(rankings.colleges || college).slice(0, 8)}
            title={(row) => row.college || "未填写"}
            meta={(row) => `${row.record_count || 0} 条记录`}
            value={(row) => Number(row.total_hours || 0)}
            suffix="小时"
          />
        </Panel>
      </div>
      <Panel title="问题状态">
        <DataTable
          columns={["问题状态", "记录数", "总时长"]}
          rows={normalizeProblemStatusRows(problemStats).map((row) => [
            <Badge key="status" tone={problemTone(row.problem_type)}>{problemTypeLabel(row.problem_type)}</Badge>,
            row.record_count,
            formatHours(row.total_hours),
          ])}
        />
      </Panel>
      <div className="two-column">
        <Panel title="按学院统计">
          <DataTable columns={["学院", "总时长", "记录数"]} rows={college.map((row) => [row.college || "未填写", formatHours(row.total_hours), row.record_count])} />
        </Panel>
        <Panel title="月份与历史导入统计">
          <p>历史活动统一标记为2026年10月之前导入，不推算发生月份。新增活动按填写的真实活动日期分月统计。</p>
          <DataTable columns={["月份 / 历史范围", "总时长", "记录数"]} rows={month.map((row) => [row.month, formatHours(row.total_hours), row.record_count])} />
        </Panel>
      </div>
    </section>
  );
}

function OpsStatusPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setStatus(await getOpsStatus());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const cards = buildOpsCards(status);
  const checklist = buildOpsChecklist(status);
  const healthyCount = cards.filter((card) => card.status === "ok" || card.status === "enabled").length;
  const attentionCount = cards.filter((card) => ["warn", "error", "disabled", "unknown"].includes(card.status)).length;

  return (
    <section className="dashboard-section">
      <SectionTitle title="Supabase / 备份 / 监控状态" subtitle={loading ? "正在读取状态" : "运维健康检查和备份链路状态"} onRefresh={load} />
      <Notice type="error" message={error} />

      <div className="metric-grid">
        <Metric label="健康项" value={healthyCount} />
        <Metric label="需关注项" value={attentionCount} />
        <Metric label="状态来源" value={status?.fallback ? "Health" : "Ops"} />
        <Metric label="最近检查" value={formatDateTime(latestOpsTime(status))} />
      </div>

      <div className="status-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article className="status-card" key={card.key}>
              <div className="status-card-heading">
                <div>
                  <Icon size={20} />
                  <h3>{card.title}</h3>
                </div>
                <Badge tone={opsTone(card.status)}>{opsLabel(card.status)}</Badge>
              </div>
              <dl className="meta-list">
                {card.items.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{formatMetaValue(item.value)}</dd>
                  </div>
                ))}
              </dl>
            </article>
          );
        })}
      </div>

      <Panel title="备份与监控检查点">
        <DataTable
          columns={["项目", "状态", "最近时间", "说明"]}
          rows={checklist.map((item) => [
            item.label,
            <Badge key="status" tone={opsTone(item.status)}>{opsLabel(item.status)}</Badge>,
            formatDateTime(item.time),
            item.message || "-",
          ])}
        />
      </Panel>
    </section>
  );
}

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(fallbackRoles);
  const [form, setForm] = useState({ username: "", password: "", real_name: "", role: "organizer", org_name: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const [userRows, roleRows] = await Promise.all([
        listUsers(),
        listRoles().catch(() => fallbackRoles),
      ]);
      setUsers(userRows || []);
      setRoles(normalizeRoles(roleRows));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    try {
      await createUser(form);
      setMessage("用户已创建");
      setForm({ username: "", password: "", real_name: "", role: "organizer", org_name: "" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reset(user) {
    const password = window.prompt(`为 ${user.username} 设置新密码`);
    if (!password) return;
    try {
      await resetUserPassword(user.id, password);
      setMessage("密码已重置");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="dashboard-section">
      <SectionTitle title="用户管理" subtitle="创建组织者或管理员，禁用账号和重置密码" onRefresh={load} />
      <Notice type="success" message={message} />
      <Notice type="error" message={error} />
      <Panel title="创建账号">
        <form className="form-grid" onSubmit={create}>
          <Field label="用户名"><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></Field>
          <Field label="初始密码"><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required type="password" /></Field>
          <Field label="真实姓名"><input value={form.real_name} onChange={(e) => setForm({ ...form, real_name: e.target.value })} required /></Field>
          <Field label="角色">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {roles.map((role) => (
                <option key={role.value} value={role.value}>{role.label}</option>
              ))}
            </select>
          </Field>
          <Field label="所属组织"><input value={form.org_name} onChange={(e) => setForm({ ...form, org_name: e.target.value })} /></Field>
          <div className="form-actions"><button className="primary-button" type="submit"><Plus size={16} />创建用户</button></div>
        </form>
      </Panel>
      <Panel title="账号列表">
        <DataTable
          columns={["用户名", "姓名", "角色", "组织", "状态", "创建时间", "操作"]}
          rows={users.map((user) => [
            user.username,
            user.real_name,
            roleLabel(user.role, roles),
            user.org_name || "-",
            <Badge key="active" tone={user.is_active ? "green" : "red"}>{user.is_active ? "启用" : "禁用"}</Badge>,
            formatDateTime(user.created_at),
            <div className="row-actions" key="actions">
              <button onClick={() => toggleUser(user.id).then(load).catch((err) => setError(err.message))}>{user.is_active ? "禁用" : "启用"}</button>
              <button onClick={() => reset(user)}>重置密码</button>
            </div>,
          ])}
        />
      </Panel>
    </section>
  );
}

function AuditPage() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      setRows(await listOperationLogs());
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="dashboard-section">
      <SectionTitle title="操作日志" subtitle="管理员和组织者关键操作审计" onRefresh={load} />
      <Notice type="error" message={error} />
      <Panel title="最近操作">
        <DataTable
          columns={["时间", "用户", "动作", "对象", "详情", "IP"]}
          rows={rows.map((row) => [
            formatDateTime(row.created_at),
            row.username || "-",
            row.action,
            row.target_type ? `${row.target_type}/${row.target_id || "-"}` : "-",
            row.detail ? JSON.stringify(row.detail) : "-",
            row.ip || "-",
          ])}
        />
      </Panel>
    </section>
  );
}

function SectionTitle({ title, subtitle, onRefresh }) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {onRefresh && <button type="button" onClick={onRefresh}><RefreshCw size={16} />刷新</button>}
    </div>
  );
}

function Panel({ title, action, children }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Notice({ type, message }) {
  if (!message) return null;
  return <div className={`notice ${type}`}>{message}</div>;
}

function Metric({ label, value }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong></article>;
}

function RankList({ rows, title, meta, value, suffix }) {
  if (!rows.length) {
    return <div className="empty-state compact">暂无排行</div>;
  }
  const max = Math.max(...rows.map((row) => Number(value(row) || 0)), 1);
  return (
    <ol className="rank-list">
      {rows.map((row, index) => {
        const numericValue = Number(value(row) || 0);
        return (
          <li key={`${title(row)}-${index}`}>
            <span className="rank-index">{index + 1}</span>
            <div className="rank-main">
              <strong>{title(row)}</strong>
              <em>{meta(row)}</em>
              <div className="rank-bar" aria-hidden="true">
                <span style={{ width: `${Math.max((numericValue / max) * 100, 4)}%` }} />
              </div>
            </div>
            <b>{formatHours(numericValue)}{suffix}</b>
          </li>
        );
      })}
    </ol>
  );
}

function ImportDiffReport({ report, reimportHints }) {
  if (!report) return null;

  return (
    <div className="diff-report">
      {reimportHints.hasHint && (
        <div className="safe-reimport">
          <div>
            <strong>同批次安全重导提示</strong>
            <p>
              {reimportHints.matchingBatches.length > 0
                ? `发现 ${reimportHints.matchingBatches.length} 个同名或同备注历史批次。`
                : "未发现同名历史批次。"}
              {reimportHints.duplicateCount > 0
                ? ` 本次预览含 ${reimportHints.duplicateCount} 条库内重复记录，需逐行确认后才会导入。`
                : " 本次预览未发现库内重复记录。"}
            </p>
          </div>
          {reimportHints.matchingBatches.length > 0 && (
            <ul>
              {reimportHints.matchingBatches.slice(0, 3).map((batch) => (
                <li key={batch.id || `${batch.filename}-${batch.created_at}`}>
                  {batch.filename || "-"} / {batch.note || "无备注"} / {formatDateTime(batch.created_at)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="diff-summary">
        <SummaryItem label="正常" value={report.status.ok || 0} />
        <SummaryItem label="待确认" value={report.status.warning || 0} />
        <SummaryItem label="错误" value={report.status.error || 0} />
        <SummaryItem label="重复提示" value={report.duplicateCount} />
        <SummaryItem label="需默认日期" value={report.dateFallbackCount} />
        <SummaryItem label="需默认活动" value={report.nameFallbackCount} />
      </div>

      <div className="two-column inner">
        <div>
          <h4>问题差异</h4>
          <DataTable
            columns={["类型", "数量"]}
            rows={report.issueRows.map((row) => [issueLabel(row.code), row.count])}
          />
        </div>
        <div>
          <h4>工作表差异</h4>
          <DataTable
            columns={["工作表", "正常", "待确认", "错误"]}
            rows={report.sheetRows.map((row) => [row.sheet, row.ok, row.warning, row.error])}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryItem({ label, value }) {
  return (
    <div className="summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Badge({ tone = "muted", children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function IssueCell({ row }) {
  if (row.status === "ok") {
    return <Badge tone="green">正常</Badge>;
  }

  const tone = row.status === "error" ? "red" : "orange";
  const label = row.status === "error" ? "错误" : "待确认";
  return (
    <div className="issue-cell">
      <Badge tone={tone}>{label}</Badge>
      {row.message && <span>{row.message}</span>}
    </div>
  );
}

function StatusBadge({ status }) {
  const label = status === "approved" ? "已通过" : status === "rejected" ? "已驳回" : "待审核";
  const tone = status === "approved" ? "green" : status === "rejected" ? "red" : "orange";
  return <Badge tone={tone}>{label}</Badge>;
}

function DataTable({ columns, rows }) {
  if (!rows.length) {
    return <div className="empty-state">暂无数据</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompactLogList({ rows }) {
  if (!rows.length) return <div className="empty-state compact">暂无待办</div>;
  return (
    <ul className="compact-list">
      {rows.map((row) => (
        <li key={row.id}>
          <strong>{row.student_name}</strong>
          <span>{row.activity_name}</span>
          <em>{formatHours(row.hours)} 小时</em>
        </li>
      ))}
    </ul>
  );
}

function activityPayload(form) {
  return {
    ...form,
    start_time: form.start_time ? new Date(form.start_time).toISOString() : null,
    end_time: form.end_time ? new Date(form.end_time).toISOString() : null,
  };
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

function formatInputDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function hasIssue(row, code) {
  return Array.isArray(row?.issues) && row.issues.some((issue) => issue.code === code);
}

function rowNeedsDateFallback(row) {
  return hasIssue(row, "missing_or_invalid_activity_date") || !isStrictDate(row?.activity_date);
}

function rowNeedsNameFallback(row) {
  return hasIssue(row, "missing_activity_name") || !String(row?.activity_name || "").trim();
}

function previewRowKey(row) {
  return `${row?.sheet || ""}:${row?.row || ""}:${row?.student_id || ""}:${row?.student_name || ""}`;
}

function isStrictDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function normalizeRoles(rows) {
  const map = new Map(fallbackRoles.map((role) => [role.value, role]));
  (Array.isArray(rows) ? rows : []).forEach((role) => {
    const value = typeof role === "string" ? role : role?.value || role?.role || role?.name;
    if (!value) return;
    map.set(value, {
      value,
      label: typeof role === "string" ? roleLabel(value) : role.label || role.name || roleLabel(value),
    });
  });
  const ordered = fallbackRoles.map((role) => map.get(role.value)).filter(Boolean);
  const extras = [...map.values()].filter((role) => !fallbackRoles.some((item) => item.value === role.value));
  return [...ordered, ...extras];
}

function roleLabel(value, roles = fallbackRoles) {
  return roles.find((role) => role.value === value)?.label
    || fallbackRoles.find((role) => role.value === value)?.label
    || value
    || "-";
}

function normalizeProblemStatusRows(stats) {
  const rows = Array.isArray(stats) ? stats : stats?.by_status || stats?.byStatus || [];
  return rows
    .map((row) => ({
      problem_type: row.problem_type || row.import_detail_status || row.status || "normal",
      record_count: Number(row.record_count ?? row.count ?? 0),
      total_hours: Number(row.total_hours ?? row.hours ?? 0),
    }))
    .sort((a, b) => b.record_count - a.record_count);
}

function getRowProblemType(row) {
  return row?.import_detail_status || row?.detail_status || row?.problem_type || row?.problem_status || "normal";
}

function isProblemType(type) {
  return Boolean(type && type !== "normal" && type !== "parsed");
}

function isProblemDataRow(row) {
  return isProblemType(getRowProblemType(row));
}

function problemTypeLabel(type) {
  return problemTypeLabels[type] || type || "未知";
}

function problemTone(type) {
  if (type === "normal" || type === "parsed") return "green";
  if (type === "summary_conflict" || type === "duplicate_record") return "red";
  if (!type || type === "unknown") return "muted";
  return "orange";
}

function buildPreviewDiffReport(preview) {
  if (!preview) return null;
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  const status = {
    ok: Number(preview.ok ?? rows.filter((row) => row.status === "ok").length),
    warning: Number(preview.warnings ?? rows.filter((row) => row.status === "warning").length),
    error: Number(preview.errors ?? rows.filter((row) => row.status === "error").length),
  };
  const issueCounts = new Map();
  const sheetCounts = new Map();
  let duplicateCount = 0;
  let dateFallbackCount = 0;
  let nameFallbackCount = 0;

  rows.forEach((row) => {
    const sheet = row.sheet || "默认工作表";
    const sheetRow = sheetCounts.get(sheet) || { sheet, ok: 0, warning: 0, error: 0 };
    if (row.status === "warning") sheetRow.warning += 1;
    else if (row.status === "error") sheetRow.error += 1;
    else sheetRow.ok += 1;
    sheetCounts.set(sheet, sheetRow);

    const issues = Array.isArray(row.issues) ? row.issues : [];
    issues.forEach((issue) => {
      const code = issue.code || row.status || "unknown";
      issueCounts.set(code, (issueCounts.get(code) || 0) + 1);
      if (code === "duplicate_record" || code === "duplicate_in_file" || code === "duplicate_in_request") {
        duplicateCount += 1;
      }
    });
    if (!issues.length && row.status && row.status !== "ok") {
      issueCounts.set(row.status, (issueCounts.get(row.status) || 0) + 1);
    }
    if (rowNeedsDateFallback(row)) dateFallbackCount += 1;
    if (rowNeedsNameFallback(row)) nameFallbackCount += 1;
  });

  let issueRows = [...issueCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
  if (!issueRows.length) {
    issueRows = [
      { code: "ok", count: status.ok },
      { code: "warning", count: status.warning },
      { code: "error", count: status.error },
    ].filter((row) => row.count > 0);
  }

  return {
    status,
    issueRows,
    sheetRows: [...sheetCounts.values()],
    duplicateCount,
    dateFallbackCount,
    nameFallbackCount,
  };
}

function buildReimportHints(preview, batches, file, note) {
  const filename = normalizeText(preview?.filename || file?.name);
  const batchNote = normalizeText(note);
  const matchingBatches = (Array.isArray(batches) ? batches : []).filter((batch) => {
    const sameFile = filename && normalizeText(batch.filename) === filename;
    const sameNote = batchNote && normalizeText(batch.note) === batchNote;
    return sameFile || sameNote;
  });
  const duplicateCount = (preview?.rows || []).filter((row) => hasIssue(row, "duplicate_record")).length;

  return {
    matchingBatches,
    duplicateCount,
    hasHint: matchingBatches.length > 0 || duplicateCount > 0,
  };
}

function issueLabel(code) {
  if (code === "ok") return "正常";
  if (code === "warning") return "待确认";
  if (code === "error") return "错误";
  return problemTypeLabel(code);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function buildOpsCards(status) {
  const source = status || {};
  const api = source.api || source.health || {};
  const database = source.database || source.db || {};
  const redis = source.redis || source.cache || {};
  const backup = source.backup || {};
  const supabase = source.supabase || source.supabase_backup || {};
  const monitor = source.monitor || source.health || {};

  return [
    {
      key: "api",
      title: "API 服务",
      icon: Server,
      status: sectionStatus(api, source.health?.status === "ok" ? "ok" : "unknown"),
      items: [
        { label: "最近检查", value: formatDateTime(pickValue(api, ["checked_at", "timestamp"], source.health?.timestamp)) },
        { label: "说明", value: pickValue(api, ["message", "detail"], source.fallback ? "使用 /health 降级状态" : "-") },
      ],
    },
    {
      key: "database",
      title: "PostgreSQL",
      icon: Database,
      status: sectionStatus(database),
      items: [
        { label: "迁移版本", value: pickValue(database, ["migration", "latest_migration", "schema_version"]) },
        { label: "记录数", value: pickValue(database, ["record_count", "total_records", "logs_count"]) },
      ],
    },
    {
      key: "redis",
      title: "Redis 缓存",
      icon: HardDrive,
      status: sectionStatus(redis),
      items: [
        { label: "连接", value: pickValue(redis, ["message", "url", "host"]) },
        { label: "Key 数", value: pickValue(redis, ["keys", "key_count", "query_keys"]) },
      ],
    },
    {
      key: "backup",
      title: "数据库备份",
      icon: ShieldCheck,
      status: sectionStatus(backup),
      items: [
        { label: "最近备份", value: formatDateTime(pickValue(backup, ["last_backup_at", "latest_backup_at", "latest.created_at", "manifest.created_at"], null)) },
        { label: "保留天数", value: pickValue(backup, ["retention_days", "retention"]) },
        { label: "文件", value: pickValue(backup, ["latest_file", "dump_file", "latest.filename", "manifest.filename"]) },
      ],
    },
    {
      key: "supabase",
      title: "Supabase 异地备份",
      icon: Cloud,
      status: sectionStatus(supabase),
      items: [
        { label: "Bucket", value: pickValue(supabase, ["bucket", "backup_bucket"]) },
        { label: "Prefix", value: pickValue(supabase, ["prefix", "backup_prefix"]) },
        { label: "最近上传", value: formatDateTime(pickValue(supabase, ["last_upload_at", "latest_upload_at", "latest.created_at"], null)) },
      ],
    },
    {
      key: "monitor",
      title: "健康监控",
      icon: Activity,
      status: sectionStatus(monitor),
      items: [
        { label: "检查地址", value: pickValue(monitor, ["url", "health_url", "message"], "/health") },
        { label: "最近检查", value: formatDateTime(pickValue(monitor, ["checked_at", "last_check_at", "timestamp"], null)) },
      ],
    },
  ];
}

function buildOpsChecklist(status) {
  const source = status || {};
  const backup = source.backup || {};
  const supabase = source.supabase || source.supabase_backup || {};
  const restore = source.restore || source.restore_safety || {};
  const monitor = source.monitor || source.api || {};

  return [
    {
      label: "数据库备份",
      status: sectionStatus(backup),
      time: pickValue(backup, ["last_backup_at", "latest_backup_at", "latest.created_at", "manifest.created_at"], null),
      message: pickValue(backup, ["message", "latest_file", "dump_file"]),
    },
    {
      label: "Supabase 上传",
      status: sectionStatus(supabase),
      time: pickValue(supabase, ["last_upload_at", "latest_upload_at", "latest.created_at"], null),
      message: pickValue(supabase, ["message", "bucket", "backup_bucket"]),
    },
    {
      label: "恢复保护",
      status: sectionStatus(restore),
      time: pickValue(restore, ["checked_at", "updated_at"], null),
      message: pickValue(restore, ["message", "guard"], "ALLOW_RESTORE"),
    },
    {
      label: "健康检查",
      status: sectionStatus(monitor, source.health?.status === "ok" ? "ok" : "unknown"),
      time: pickValue(monitor, ["checked_at", "last_check_at", "timestamp"], source.health?.timestamp || null),
      message: pickValue(monitor, ["message", "url", "health_url"], "/health"),
    },
  ];
}

function latestOpsTime(status) {
  return pickValue(status || {}, [
    "api.checked_at",
    "monitor.checked_at",
    "monitor.last_check_at",
    "backup.last_backup_at",
    "supabase.last_upload_at",
    "health.timestamp",
  ], null);
}

function sectionStatus(section, fallback = "unknown") {
  if (!section) return fallback;
  if (typeof section === "string") return section.toLowerCase();
  if (section.status || section.state) return String(section.status || section.state).toLowerCase();
  if (section.enabled === true) return "enabled";
  if (section.enabled === false) return "disabled";
  return fallback;
}

function opsTone(status) {
  if (status === "ok" || status === "enabled" || status === "healthy") return "green";
  if (status === "error" || status === "failed" || status === "down") return "red";
  if (status === "warn" || status === "warning" || status === "degraded" || status === "pending") return "orange";
  return "muted";
}

function opsLabel(status) {
  const labels = {
    ok: "正常",
    healthy: "正常",
    enabled: "已启用",
    warn: "需关注",
    warning: "需关注",
    degraded: "降级",
    pending: "待检查",
    disabled: "未启用",
    error: "异常",
    failed: "失败",
    down: "不可用",
    unknown: "待接入",
  };
  return labels[status] || status || "待接入";
}

function pickValue(source, paths, fallback = "-") {
  for (const path of paths) {
    const value = String(path).split(".").reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return fallback;
}

function formatMetaValue(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default App;

