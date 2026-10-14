const API_BASE = "/api/v1";

async function request(path, options = {}) {
  const token = localStorage.getItem("adminToken");
  const headers = { ...(options.headers || {}) };

  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    if (response.status === 401 && token) {
      localStorage.removeItem('adminToken');
      window.dispatchEvent(new Event('admin-session-expired'));
    }
    const message = data?.message || data?.error || data || "请求失败";
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function toQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, value);
    }
  });
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function login(payload) {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getMe() {
  return request("/auth/me");
}

export function getOverview() {
  return request("/stats/overview");
}

export function searchStudent(mode, value, otherValue = '', page = 1) {
  return request('/admin-search', {
    method: 'POST',
    body: JSON.stringify({ mode, value, other_value: otherValue, page }),
  });
}

export function getStatsByCollege() {
  return request("/stats/by-college");
}

export function getStatsByMonth() {
  return request("/stats/by-month");
}

export function getStatsRankings() {
  return request("/stats/rankings");
}

export function getProblemStats() {
  return request("/stats/problems");
}

export function exportStats() {
  return downloadFile("/stats/export", "volunteer-stats.xlsx");
}

export function listActivities(params = {}) {
  return request(`/activities${toQuery(params)}`);
}

export function createActivity(payload) {
  return request("/activities", { method: "POST", body: JSON.stringify(payload) });
}

export function updateActivity(id, payload) {
  return request(`/activities/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

export function archiveActivity(id) {
  return request(`/activities/${id}/archive`, { method: "PATCH" });
}

export function unarchiveActivity(id) {
  return request(`/activities/${id}/unarchive`, { method: "PATCH" });
}

export function listLogs(params) {
  return request(`/logs${toQuery(params)}`);
}

export function submitLogs(payload) {
  return request("/logs", { method: "POST", body: JSON.stringify(payload) });
}

export function approveLog(id) {
  return request(`/logs/${id}/approve`, { method: "PATCH" });
}

export function rejectLog(id, reason) {
  return request(`/logs/${id}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ reason }),
  });
}

export function batchApprove(ids) {
  return request("/logs/batch-approve", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function markProcessed(id) {
  return request(`/logs/${id}/mark-processed`, { method: "PATCH" });
}

export function listProblemLogs(params) {
  return request(`/reviews/problem-logs${toQuery(params)}`);
}

export function getProblemSourceRow(id) {
  return request(`/reviews/logs/${id}/source-row`);
}

export function updateProblemLog(id, payload) {
  return request(`/reviews/logs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function previewImport(file) {
  const body = new FormData();
  body.append("file", file);
  return request("/import/preview", { method: "POST", body });
}

export function confirmImport(payload) {
  return request("/import/confirm", { method: "POST", body: JSON.stringify(payload) });
}

export function listImportBatches() {
  return request("/import/batches");
}

export function downloadImportTemplate() {
  return downloadFile("/import/template", "volunteer-import-template.xlsx");
}

export function listUsers(params = {}) {
  return request(`/users${toQuery(params)}`);
}

export function listRoles() {
  return request("/users/roles");
}

export function createUser(payload) {
  return request("/users", { method: "POST", body: JSON.stringify(payload) });
}

export function toggleUser(id) {
  return request(`/users/${id}/toggle-active`, { method: "PATCH" });
}

export function resetUserPassword(id, newPassword) {
  return request(`/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ new_password: newPassword }),
  });
}

export function listOperationLogs() {
  return request("/users/operation-logs");
}

export async function getOpsStatus() {
  try {
    return await request("/ops/status");
  } catch (err) {
    if (err.status && err.status !== 404) {
      throw err;
    }

    const health = await requestHealth().catch((healthErr) => ({
      status: "error",
      message: healthErr.message,
      timestamp: null,
    }));
    const apiOk = health.status === "ok";

    return {
      fallback: true,
      api: {
        status: apiOk ? "ok" : "error",
        message: apiOk ? "健康检查可用" : health.message || "健康检查失败",
        checked_at: health.timestamp,
      },
      database: {
        status: "unknown",
        message: "等待后端运维状态接口返回数据库状态",
      },
      redis: {
        status: "unknown",
        message: "等待后端运维状态接口返回缓存状态",
      },
      backup: {
        status: "unknown",
        message: "等待后端运维状态接口返回最近备份信息",
      },
      supabase: {
        status: "unknown",
        message: "等待后端运维状态接口返回异地备份信息",
      },
      monitor: {
        status: apiOk ? "ok" : "error",
        message: "/health",
        checked_at: health.timestamp,
      },
      health,
    };
  }
}

async function requestHealth() {
  const response = await fetch("/health");
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    const message = data?.message || data?.error || data || "健康检查失败";
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function downloadFile(path, filename) {
  const token = localStorage.getItem("adminToken");
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "下载失败");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function getAcademicSummary(params) { return request(`/stats/academic-summary${toQuery(params)}`); }
export const getPublicationStatus = () => request('/publications');
export const publishHours = (body) => request('/publications', { method: 'POST', body: JSON.stringify(body) });

export const logout = () => request('/auth/logout', {method:'POST'});
export const getActivity = id => request(`/activities/${id}`);
export const deleteActivity = id => request(`/activities/${id}`, {method:'DELETE'});
export const restoreActivity = id => request(`/activities/${id}/restore`, {method:'POST'});
export const deleteUser = id => request(`/users/${id}`, {method:'DELETE'});
export const restoreUser = id => request(`/users/${id}/restore`, {method:'POST'});
export const updateUser = (id,body) => request(`/users/${id}`, {method:'PATCH',body:JSON.stringify(body)});
export const retireLog = (id,reason) => request(`/logs/${id}`, {method:'DELETE',body:JSON.stringify({reason})});
export const restoreLog = (id,reason) => request(`/logs/${id}/restore`, {method:'POST',body:JSON.stringify({reason})});
export const resubmitLog = (id,body) => request(`/logs/${id}/resubmit`, {method:'PATCH',body:JSON.stringify(body)});
export const prepareImport = body => request('/import/prepare', {method:'POST',body:JSON.stringify(body)});
export const previewParticipants = body => request('/logs/preview', {method:'POST',body:JSON.stringify(body)});
export function previewParticipantFile(id,file) {const body=new FormData();body.append('file',file);return request(`/logs/preview-file?activity_id=${encodeURIComponent(id)}`,{method:'POST',body});}
export const downloadParticipantTemplate = () => downloadFile('/logs/template','activity-participants.xlsx');
