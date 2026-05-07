const FORMAL_COLLEGES = [
  '车辆工程学院',
  '机械工程学院',
  '材料科学与工程学院',
  '电气与电子工程学院',
  '计算机科学与工程学院',
  '药学与生物工程学院',
  '化学化工学院',
  '数学科学学院',
  '会计学院',
  '管理学院',
  '创新创业学院',
  '经济金融学院',
  '马克思主义学院',
  '重庆知识产权学院',
  '语言与传播学院',
  '两江国际学院',
  '两江人工智能学院',
  '物理与新能源学院',
  '应用技术学院',
];

const ALIASES = {
  车辆学院: '车辆工程学院',
  车辆: '车辆工程学院',
  机械学院: '机械工程学院',
  机械: '机械工程学院',
  材料学院: '材料科学与工程学院',
  材科学院: '材料科学与工程学院',
  材料科学学院: '材料科学与工程学院',
  材料: '材料科学与工程学院',
  电气学院: '电气与电子工程学院',
  电子与电气学院: '电气与电子工程学院',
  电气电子学院: '电气与电子工程学院',
  电气: '电气与电子工程学院',
  计算机学院: '计算机科学与工程学院',
  计算机: '计算机科学与工程学院',
  药生学院: '药学与生物工程学院',
  药学与生物学院: '药学与生物工程学院',
  药生: '药学与生物工程学院',
  化工学院: '化学化工学院',
  化学学院: '化学化工学院',
  数学学院: '数学科学学院',
  数学: '数学科学学院',
  会计: '会计学院',
  管理: '管理学院',
  创新创业: '创新创业学院',
  经金学院: '经济金融学院',
  经金: '经济金融学院',
  马院: '马克思主义学院',
  马克思学院: '马克思主义学院',
  知产学院: '重庆知识产权学院',
  知识产权学院: '重庆知识产权学院',
  知产: '重庆知识产权学院',
  语传学院: '语言与传播学院',
  语传: '语言与传播学院',
  国际学院: '两江国际学院',
  两江国际: '两江国际学院',
  人工智能学院: '两江人工智能学院',
  人智学院: '两江人工智能学院',
  人智: '两江人工智能学院',
  物新学院: '物理与新能源学院',
  物新: '物理与新能源学院',
  物理新能源学院: '物理与新能源学院',
  物理与系能源学院: '物理与新能源学院',
  应用技术学校: '应用技术学院',
  应用技术: '应用技术学院',
};

const aliasByKey = new Map();

for (const formal of FORMAL_COLLEGES) {
  aliasByKey.set(toCollegeKey(formal), formal);
}

for (const [alias, formal] of Object.entries(ALIASES)) {
  aliasByKey.set(toCollegeKey(alias), formal);
}

function toCollegeKey(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[。．.，,、；;：:]/g, '')
    .trim();
}

function normalizeCollegeName(value) {
  const text = String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return aliasByKey.get(toCollegeKey(text)) || text;
}

function isFormalCollegeName(value) {
  return FORMAL_COLLEGES.includes(normalizeCollegeName(value));
}

module.exports = {
  FORMAL_COLLEGES,
  normalizeCollegeName,
  isFormalCollegeName,
  toCollegeKey,
};
