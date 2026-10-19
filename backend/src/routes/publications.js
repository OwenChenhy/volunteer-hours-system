const publication = require('../services/publicationService');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');
const db = require('../db');
const { createArchive } = require('../services/publicationExportService');

module.exports = async function (app) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireCapability('publication:manage'));
  app.get('/', async () => publication.status());
  app.get('/export', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    publication_id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }
  } } } }, async (request, reply) => {
    const id = request.query.publication_id;
    const result = id
      ? await db.query('SELECT * FROM publication_batches WHERE id=$1', [id])
      : await db.query('SELECT p.* FROM publication_state s JOIN publication_batches p ON p.id=s.publication_id WHERE s.id=true');
    const batch = result.rows[0];
    if (!batch) return reply.code(404).send({ message: '未找到可导出的公示版本' });
    try {
      const exported = await createArchive(batch);
      await writeAudit(request, 'publication.export', 'publication', batch.id, {
        record_count: exported.recordCount, student_count: exported.studentCount,
        workbook_count: exported.workbookCount, fallback_colleges: exported.fallbackColleges
      });
      return reply.header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="volunteer-publication-${batch.publication_month}.zip"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`)
        .header('Cache-Control', 'private, no-store')
        .header('X-Publication-Id', batch.id)
        .header('X-Export-Students', String(exported.studentCount))
        .send(exported.buffer);
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
  });
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
