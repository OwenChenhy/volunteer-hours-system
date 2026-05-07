const assert = require('assert');
const {
  FORMAL_COLLEGES,
  normalizeCollegeName,
  isFormalCollegeName,
} = require('../src/utils/collegeNames');

const cases = {
  车辆学院: '车辆工程学院',
  '机械工程学院 ': '机械工程学院',
  材料学院: '材料科学与工程学院',
  材科学院: '材料科学与工程学院',
  电气学院: '电气与电子工程学院',
  电子与电气学院: '电气与电子工程学院',
  计算机学院: '计算机科学与工程学院',
  计算机: '计算机科学与工程学院',
  药生学院: '药学与生物工程学院',
  化工学院: '化学化工学院',
  经金学院: '经济金融学院',
  知产学院: '重庆知识产权学院',
  语传学院: '语言与传播学院',
  国际学院: '两江国际学院',
  人工智能学院: '两江人工智能学院',
  人智学院: '两江人工智能学院',
  人智: '两江人工智能学院',
  物新学院: '物理与新能源学院',
  物新: '物理与新能源学院',
  应用技术学校: '应用技术学院',
  '应用技术学院。': '应用技术学院',
};

for (const [input, expected] of Object.entries(cases)) {
  assert.strictEqual(normalizeCollegeName(input), expected, input);
}

for (const formal of FORMAL_COLLEGES) {
  assert.strictEqual(normalizeCollegeName(formal), formal);
  assert.strictEqual(isFormalCollegeName(formal), true);
}

console.log(JSON.stringify({
  ok: true,
  formal_colleges: FORMAL_COLLEGES.length,
  alias_cases: Object.keys(cases).length,
}, null, 2));
