const publication = require('../services/publicationService');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');

module.exports = async function (app) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireCapability('publication:manage'));
  app.get('/', async () => publication.status());
  app.post('/', { schema: { body: { type: 'object', required: ['publication_month', 'label'], properties: {
    publication_month: { type: 'string', pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$' },
    label: { type: 'string', minLength: 1, maxLength: 128 }
  } } } }, async (request, reply) => {
    try {
      const state = await publication.publish(request.user.id, request.body);
      await writeAudit(request, 'publication.publish', 'publication', state.batch.id, { month: state.batch.publication_month, record_count: state.batch.record_count, source_revision: state.batch.source_revision });
      return publication.meta(state);
    } catch (error) {
      if (error.statusCode === 409) return reply.code(409).send({ message: error.message });
      throw error;
    }
  });
};
