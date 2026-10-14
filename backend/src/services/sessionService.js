const db = require('../db');
const {
  ROLE_CAPABILITIES
} = require('../middlewares/rbac');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function currentUser(decoded) {
  if (!UUID.test(decoded?.id || '')) return null;
  const user = (await db.query(`SELECT id,username,real_name,role,org_name,is_active,deleted_at,session_version
    FROM users WHERE id=$1`, [decoded.id])).rows[0];
  if (!user || !user.is_active || user.deleted_at || !ROLE_CAPABILITIES[user.role]) return null;
  if (Number(decoded.session_version || 0) !== Number(user.session_version || 0)) return null;
  return user;
}
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    real_name: user.real_name,
    role: user.role,
    org_name: user.org_name,
    capabilities: ROLE_CAPABILITIES[user.role] || [],
    scope: user.role === 'college_admin' ? {
      type: 'college',
      college: user.org_name
    } : user.role === 'organizer' ? {
      type: 'own'
    } : {
      type: 'all'
    }
  };
}
module.exports = {
  currentUser,
  publicUser,
  UUID
};
