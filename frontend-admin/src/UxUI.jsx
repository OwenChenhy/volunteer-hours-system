import { cloneElement, useEffect, useId, useRef, useState } from 'react';
export const hours = value => Number(value || 0).toFixed(1);
export const states = {
  pending: '待审核',
  approved: '审核通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
  voided: '已作废'
};
export function Banner({
  error,
  message
}) {
  return <>{error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}</>;
}
export function Panel({
  title,
  action,
  children
}) {
  return <section className="panel"><div className="panel-heading"><h3>{title}</h3>{action}</div><div className="panel-body">{children}</div></section>;
}
export function Field({
  label,
  children,
  hint
}) {
  const generated = useId(),
    id = children.props.id || generated;
  return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, {
      id,
      'aria-describedby': hint ? `${id}-hint` : children.props['aria-describedby']
    })}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function Steps({
  labels,
  current
}) {
  return <ol className="ux-steps" aria-label="操作步骤">{labels.map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined} className={index <= current ? 'current' : ''}><span>{index + 1}</span>{label}</li>)}</ol>;
}
export function Table({
  columns,
  rows
}) {
  return <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length ? rows.map((cells, index) => <tr key={index}>{cells.map((cell, n) => <td key={n}>{cell}</td>)}</tr>) : <tr><td colSpan={columns.length}><div className="empty-state">暂无记录</div></td></tr>}</tbody></table></div>;
}
export function ActionDialog({
  dialog,
  onClose,
  onConfirm
}) {
  const box = useRef(null),
    [reason, setReason] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!dialog) return;
    setReason('');
    setPassword('');
    setError('');
    const original = document.activeElement;
    box.current?.querySelector('input,textarea,button')?.focus();
    return () => original?.focus?.();
  }, [dialog]);
  if (!dialog) return null;
  async function confirm(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm({
        reason: reason.trim(),
        password
      });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return <div className="ux-dialog-backdrop"><section ref={box} className="ux-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ux-dialog-title" aria-describedby="ux-dialog-description" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const fields = [...box.current.querySelectorAll('button:not(:disabled),input,textarea')],
          first = fields[0],
          last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }}><h2 id="ux-dialog-title">{dialog.title}</h2><p id="ux-dialog-description">{dialog.description}</p><Banner error={error} /><form className="stack-form" onSubmit={confirm}>
    {dialog.reason && <Field label="操作原因"><textarea required maxLength={512} value={reason} onChange={event => setReason(event.target.value)} rows={3} /></Field>}
    {dialog.password && <Field label="新密码"><input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></Field>}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy || dialog.blocked} className={dialog.danger ? 'danger-button' : 'primary-button'}>{busy ? '处理中…' : dialog.confirm || '确认操作'}</button></div>
  </form></section></div>;
}
export function useUnsavedChanges(dirty) {
  useEffect(() => {
    if (!dirty) return;
    const leave = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = event => {
      if (!window.confirm('还有未保存的输入，确定离开当前流程吗？')) event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('admin-before-navigate', navigate);
    return () => {
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('admin-before-navigate', navigate);
    };
  }, [dirty]);
}
