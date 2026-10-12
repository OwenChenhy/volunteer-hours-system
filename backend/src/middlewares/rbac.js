const ROLE_LABELS = {
  super_admin: '超级管理员',
  admin: '管理员',
  data_admin: '数据管理员',
  college_admin: '学院管理员',
  auditor: '只读审计员',
  organizer: '活动组织者',
};

const ROLE_CAPABILITIES = {
  super_admin: ['*'],
  admin: ['*'],
  data_admin: [
    'logs:review',
    'import:manage',
    'stats:read',
    'reviews:manage',
    'ops:read',
    'audit:read',
  ],
  college_admin: [
    'activities:write',
    'logs:submit',
    'stats:read',
    'reviews:read',
    'audit:read',
  ],
  auditor: [
    'stats:read',
    'reviews:read',
    'ops:read',
    'audit:read',
  ],
  organizer: [
    'activities:write',
    'logs:submit',
  ],
};

function hasCapability(role, capability) {
  const capabilities = ROLE_CAPABILITIES[role] || [];
  return capabilities.includes('*') || capabilities.includes(capability);
}

function hasFullAccess(user) {
  return hasCapability(user?.role, '*');
}

function requireRole(role) {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ message: '未授权' });
    }
    // admin 拥有所有权限
    if (!hasFullAccess(request.user) && request.user.role !== role) {
      return reply.code(403).send({ message: '权限不足' });
    }
  };
}

function requireCapability(capability) {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ message: '未授权' });
    }
    if (!hasCapability(request.user.role, capability)) {
      return reply.code(403).send({ message: '权限不足' });
    }
  };
}

const isAdmin = requireCapability('*');
const isOrganizer = requireCapability('logs:submit');

module.exports = {
  ROLE_LABELS,
  ROLE_CAPABILITIES,
  hasCapability,
  hasFullAccess,
  requireRole,
  requireCapability,
  isAdmin,
  isOrganizer,
};
