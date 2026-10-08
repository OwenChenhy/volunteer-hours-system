const endpoint = '/api/v1/ops/public-status';
const labels = { ok: '正常', warning: '需关注', error: '异常', unavailable: '未连接' };

function text(id, value) { document.getElementById(id).textContent = value; }
function number(value) { return typeof value === 'number' ? value.toLocaleString('zh-CN') : '—'; }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无'; }
function state(name, status) {
  const dot = document.getElementById(`${name}-dot`);
  dot.className = `dot ${status || 'unavailable'}`;
  text(`${name}-label`, labels[status] || '未知');
}

async function refresh() {
  const button = document.getElementById('refresh');
  button.disabled = true;
  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error('status unavailable');
    const data = await response.json();
    const overall = data.overall || 'warning';
    const overview = document.querySelector('.overview');
    overview.className = `overview ${overall}`;
    document.getElementById('overall-dot').className = `dot ${overall}`;
    text('overall-text', overall === 'ok' ? '所有系统运行正常' : overall === 'error' ? '服务异常' : '部分服务需要关注');
    text('overview-detail', overall === 'ok' ? '查询服务、数据库与异地副本均可用' : '请查看下方组件状态');
    text('checked-at', `检查于 ${date(data.checked_at)}`);
    for (const name of ['api', 'database', 'supabase', 'backup', 'source_files']) state(name, data[name]?.status);
    const local = data.database || {};
    const remote = data.supabase?.counts || {};
    text('logs', number(local.volunteer_logs));
    text('activities', number(local.activities));
    text('batches', number(local.import_batches));
    text('hours', typeof local.total_hours === 'number' ? `${number(local.total_hours)} 小时` : '—');
    text('supabase-detail', remote.volunteer_logs === undefined ? '异地数据副本' : `云端 ${number(remote.volunteer_logs)} 条 / 主库 ${number(local.volunteer_logs)} 条`);
    text('backup-detail', data.backup?.latest_at ? `最近备份 ${date(data.backup.latest_at)}` : '暂无可用备份');
    const sources = data.source_files || {};
    text('source_files-detail', `已找到 ${number(sources.available)} / ${number(sources.expected)} 个原始文件`);
  } catch {
    document.querySelector('.overview').className = 'overview error';
    document.getElementById('overall-dot').className = 'dot error';
    text('overall-text', '状态接口不可用');
    text('overview-detail', '请稍后刷新');
    state('api', 'error');
  } finally {
    button.disabled = false;
  }
}

document.getElementById('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 60000);
