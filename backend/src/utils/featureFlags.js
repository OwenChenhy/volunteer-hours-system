module.exports = {
  isExcelImportEnabled: () => process.env.FEATURE_EXCEL_IMPORT !== 'false'
};