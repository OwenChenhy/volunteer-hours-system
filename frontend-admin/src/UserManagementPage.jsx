import { useEffect, useState } from 'react';
import { createUser, deleteUser, listRoles, listUsers, resetUserPassword, restoreUser, toggleUser, updateUser } from './api';
import { useSession } from './SessionContext';
import { ActionDialog, Banner, Field, Panel, Table } from './UxUI';
const blank = {
  username: '',
  password: '',
  real_name: '',
  role: 'organizer',
  org_name: ''
};
export default function UserManagementPage() {
  const {
    user,
    refresh
  } = useSession();
  const [rows, setRows] = useState([]),
    [roles, setRoles] = useState([]),
    [form, setForm] = useState(null),
    [deleted, setDeleted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [dialog, setDialog] = useState(null);
  async function load() {
    setError('');
    try {
      const [users, roleOptions] = await Promise.all([listUsers({
        include_deleted: deleted ? 'true' : ''
      }), listRoles()]);
      setRows(users);
      setRoles(roleOptions);
    } catch (failure) {
      setError(failure.message);
    }
  }
  useEffect(() => {
    load();
  }, [deleted]);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (form.id) await updateUser(form.id, {
        real_name: form.real_name,
        role: form.role,
        org_name: form.org_name
      });else await createUser(form);
      if (form.id === user.id) await refresh();
      setForm(null);
      setMessage('账号已保存。角色或单位变更后，旧登录会话自动失效。');
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm({
    password
  }) {
    if (dialog.action === 'delete') await deleteUser(dialog.row.id);else if (dialog.action === 'restore') await restoreUser(dialog.row.id);else if (dialog.action === 'password') await resetUserPassword(dialog.row.id, password);else await toggleUser(dialog.row.id);
    setMessage(dialog.action === 'restore' ? '账号已恢复为停用状态，请核对后启用' : '操作已完成，相关旧会话已失效');
    setDialog(null);
    await load();
  }
  function action(row, type) {
    setDialog({
      row,
      action: type,
      title: type === 'delete' ? '删除用户账号' : type === 'restore' ? '恢复用户账号' : type === 'password' ? '重置密码' : row.is_active ? '停用用户账号' : '启用用户账号',
      description: type === 'delete' ? `${row.username}将无法登录，已创建的活动、审核与操作记录保留。` : type === 'restore' ? `${row.username}恢复后保持停用，核对角色和所属单位后再启用。` : type === 'password' ? `为${row.username}设置新密码，已有会话将失效。` : `确认${row.is_active ? '停用' : '启用'}${row.username}。`,
      password: type === 'password',
      danger: type === 'delete' || type === 'toggle' && row.is_active,
      confirm: type === 'delete' ? '确认删除' : type === 'restore' ? '确认恢复' : '确认操作'
    });
  }
  return <section className="dashboard-section"><div className="section-title"><div><h2>账号管理</h2><p>管理账号角色、所属单位和登录状态。</p></div><button className="primary-button" onClick={() => setForm({
        ...blank
      })}>新增账号</button></div><Banner error={error} message={message} />
    {form && <Panel title={form.id ? '编辑账号' : '新增账号'}><form className="form-grid" onSubmit={save}>
      <Field label="用户名"><input required maxLength={64} disabled={!!form.id} value={form.username} onChange={event => setForm({
            ...form,
            username: event.target.value
          })} /></Field>
      {!form.id && <Field label="初始密码" hint="8至128位"><input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={form.password} onChange={event => setForm({
            ...form,
            password: event.target.value
          })} /></Field>}
      <Field label="姓名"><input required maxLength={64} value={form.real_name} onChange={event => setForm({
            ...form,
            real_name: event.target.value
          })} /></Field><Field label="角色"><select value={form.role} onChange={event => setForm({
            ...form,
            role: event.target.value
          })}>{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></Field><Field label={form.role === 'college_admin' ? '所属学院（正式全称）' : '所属单位'}><input required={form.role === 'college_admin'} maxLength={128} value={form.org_name || ''} onChange={event => setForm({
            ...form,
            org_name: event.target.value
          })} /></Field><div className="form-actions"><button type="button" onClick={() => setForm(null)}>取消</button><button disabled={busy} className="primary-button">{busy ? '保存中…' : '保存账号'}</button></div></form></Panel>}
    <div className="toolbar"><label className="inline-check"><input type="checkbox" checked={deleted} onChange={event => setDeleted(event.target.checked)} />显示已删除账号</label><button onClick={load}>刷新列表</button></div>
    <Panel title={`账号列表 · ${rows.length}个`}><Table columns={['账号', '姓名', '角色', '所属单位', '状态', '操作']} rows={rows.map(row => [row.username, row.real_name, roles.find(role => role.value === row.role)?.label || row.role, row.org_name || '未配置', row.deleted_at ? '已删除' : row.is_active ? '启用' : '停用', <div className="row-actions">
      {row.deleted_at ? <button onClick={() => action(row, 'restore')}>恢复</button> : <><button onClick={() => setForm({
            ...row,
            password: ''
          })}>编辑</button><button disabled={row.id === user.id} onClick={() => action(row, 'toggle')}>{row.is_active ? '停用' : '启用'}</button><button onClick={() => action(row, 'password')}>重置密码</button><button disabled={row.id === user.id} className="danger-text" onClick={() => action(row, 'delete')}>删除</button></>}
    </div>])} /></Panel><ActionDialog dialog={dialog} onClose={() => setDialog(null)} onConfirm={confirm} /></section>;
}
