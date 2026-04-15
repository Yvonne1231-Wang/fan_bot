import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  _testing,
  menuArchiveSaveTool,
  menuArchiveDiffTool,
  menuArchiveQueryTool,
} from './index.js';

const {
  isLegacyDayEntry,
  normalizeDayEntry,
  ARCHIVE_DIR,
} = _testing;

// ─── isLegacyDayEntry ────────────────────────────────────────────────

describe('isLegacyDayEntry', () => {
  it('标准数组格式返回 false', () => {
    const entry = [
      { date: '2026-04-14', meal: 'lunch' as const, dishes: [], archivedAt: 0 },
    ];
    expect(isLegacyDayEntry(entry)).toBe(false);
  });

  it('旧格式（含 dishes 数组的 meal 对象）返回 true', () => {
    const entry = {
      lunch: {
        dishes: [{ name: '红烧肉', stall: 'A档' }],
        restaurants: [],
        source_chat: 'oc_xxx',
      },
    };
    expect(isLegacyDayEntry(entry)).toBe(true);
  });

  it('空对象返回 false', () => {
    expect(isLegacyDayEntry({})).toBe(false);
  });

  it('对象但无 dishes 字段返回 false', () => {
    const entry = { lunch: { restaurants: [] } };
    // @ts-expect-error 故意传入不合规格式
    expect(isLegacyDayEntry(entry)).toBe(false);
  });

  it('dishes 不是数组返回 false', () => {
    const entry = { lunch: { dishes: 'not-an-array' } };
    // @ts-expect-error 故意传入不合规格式
    expect(isLegacyDayEntry(entry)).toBe(false);
  });

  it('多餐次旧格式返回 true', () => {
    const entry = {
      lunch: { dishes: [{ name: '番茄炒蛋', stall: 'B档' }] },
      dinner: { dishes: [{ name: '宫保鸡丁', stall: 'C档' }] },
    };
    expect(isLegacyDayEntry(entry)).toBe(true);
  });
});

// ─── normalizeDayEntry ───────────────────────────────────────────────

describe('normalizeDayEntry', () => {
  it('标准数组格式原样返回', () => {
    const records = [
      {
        date: '2026-04-14',
        meal: 'lunch' as const,
        dishes: [{ name: '红烧肉', stall: 'A档' }],
        archivedAt: 1000,
      },
    ];
    expect(normalizeDayEntry('2026-04-14', records)).toBe(records);
  });

  it('旧格式正确转换为 DailyMenuRecord[]', () => {
    const legacy = {
      lunch: {
        dishes: [
          { name: '沙爹牛肉饭', stall: 'T4B-5F 棒约翰', tags: ['新品'], meal: 'lunch' },
          { name: '红汤牛肚面', stall: 'T4B-5F 棒约翰', tags: ['新品'], meal: 'lunch' },
        ],
        restaurants: [],
        source_chat: 'oc_b2af5aa016c655d3cc07b795c466e030',
        extracted_at: '2026-04-14T12:00:00Z',
      },
      dinner: {
        dishes: [
          { name: '麻辣香锅', stall: 'T4B-4F 川味馆' },
        ],
        restaurants: [],
      },
    };

    const result = normalizeDayEntry('2026-04-14', legacy);
    expect(result).toHaveLength(2);

    const lunchRecord = result.find((r) => r.meal === 'lunch');
    expect(lunchRecord).toBeDefined();
    expect(lunchRecord!.date).toBe('2026-04-14');
    expect(lunchRecord!.dishes).toHaveLength(2);
    expect(lunchRecord!.dishes[0].name).toBe('沙爹牛肉饭');
    expect(lunchRecord!.archivedAt).toBe(0);

    const dinnerRecord = result.find((r) => r.meal === 'dinner');
    expect(dinnerRecord).toBeDefined();
    expect(dinnerRecord!.dishes).toHaveLength(1);
  });

  it('空对象返回空数组', () => {
    expect(normalizeDayEntry('2026-04-14', {})).toEqual([]);
  });

  it('旧格式中跳过非 meal 的异常 key', () => {
    const legacy = {
      lunch: {
        dishes: [{ name: '鱼香肉丝', stall: 'D档' }],
      },
      metadata: 'some-string-value',
    };
    // @ts-expect-error 故意包含非法 key
    const result = normalizeDayEntry('2026-04-14', legacy);
    // metadata 不含 dishes，被跳过
    expect(result).toHaveLength(1);
    expect(result[0].meal).toBe('lunch');
  });

  it('breakfast 餐次正确识别', () => {
    const legacy = {
      breakfast: {
        dishes: [{ name: '豆浆油条', stall: 'E档' }],
      },
    };
    const result = normalizeDayEntry('2026-04-14', legacy);
    expect(result).toHaveLength(1);
    expect(result[0].meal).toBe('breakfast');
  });
});

// ─── menuArchiveSaveTool ─────────────────────────────────────────────

describe('menuArchiveSaveTool.handler', () => {
  const testDir = join(ARCHIVE_DIR);
  const testYearMonth = '2099-01';
  const testDate = '2099-01-15';

  afterEach(async () => {
    // 清理测试数据
    try {
      await rm(join(testDir, `${testYearMonth}.json`));
    } catch {
      // ignore
    }
  });

  it('存档新菜品到空月份', async () => {
    const result = await menuArchiveSaveTool.handler({
      date: testDate,
      meal: 'lunch',
      dishes: [{ name: '测试菜A', stall: '测试档口' }],
    });

    expect(result).toContain('已存档');
    expect(result).toContain('午餐');
    expect(result).toContain('1 道菜品');

    // 验证写入的是标准数组格式
    const content = JSON.parse(
      await readFile(join(testDir, `${testYearMonth}.json`), 'utf-8'),
    );
    expect(Array.isArray(content[testDate])).toBe(true);
    expect(content[testDate]).toHaveLength(1);
    expect(content[testDate][0].meal).toBe('lunch');
  });

  it('覆盖旧格式数据后写入标准格式', async () => {
    // 先写入旧格式
    await mkdir(testDir, { recursive: true });
    const legacyArchive = {
      [testDate]: {
        lunch: {
          dishes: [{ name: '旧菜A', stall: '旧档口' }],
          restaurants: [],
        },
      },
    };
    await writeFile(
      join(testDir, `${testYearMonth}.json`),
      JSON.stringify(legacyArchive, null, 2),
      'utf-8',
    );

    // 用 save tool 写入同日同餐次
    const result = await menuArchiveSaveTool.handler({
      date: testDate,
      meal: 'lunch',
      dishes: [{ name: '新菜B', stall: '新档口' }],
    });

    expect(result).toContain('已存档');

    // 验证旧格式已被转换为标准数组格式
    const content = JSON.parse(
      await readFile(join(testDir, `${testYearMonth}.json`), 'utf-8'),
    );
    expect(Array.isArray(content[testDate])).toBe(true);
    // lunch 被覆盖
    const lunchRecords = content[testDate].filter(
      (r: { meal: string }) => r.meal === 'lunch',
    );
    expect(lunchRecords).toHaveLength(1);
    expect(lunchRecords[0].dishes[0].name).toBe('新菜B');
  });

  it('添加新餐次保留已有数据', async () => {
    // 先存一个 lunch
    await menuArchiveSaveTool.handler({
      date: testDate,
      meal: 'lunch',
      dishes: [{ name: '午餐菜', stall: '午餐档' }],
    });

    // 再存一个 dinner
    const result = await menuArchiveSaveTool.handler({
      date: testDate,
      meal: 'dinner',
      dishes: [{ name: '晚餐菜', stall: '晚餐档' }],
    });

    expect(result).toContain('晚餐');

    const content = JSON.parse(
      await readFile(join(testDir, `${testYearMonth}.json`), 'utf-8'),
    );
    expect(content[testDate]).toHaveLength(2);
  });

  it('空菜品列表返回提示', async () => {
    const result = await menuArchiveSaveTool.handler({
      meal: 'lunch',
      dishes: [],
    });
    expect(result).toContain('没有菜品数据');
  });

  it('breakfast 餐次正确标签', async () => {
    const result = await menuArchiveSaveTool.handler({
      date: testDate,
      meal: 'breakfast',
      dishes: [{ name: '豆浆', stall: '早餐档' }],
    });
    expect(result).toContain('早餐');
  });
});

// ─── menuArchiveQueryTool ────────────────────────────────────────────

describe('menuArchiveQueryTool.handler', () => {
  const testYearMonth = '2099-02';
  const testDate = '2099-02-10';
  const testDir = ARCHIVE_DIR;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    // 写入测试数据（标准格式）
    const archive = {
      [testDate]: [
        {
          date: testDate,
          meal: 'lunch',
          dishes: [
            { name: '红烧肉', stall: 'A档口', tags: ['经典'] },
            { name: '清炒时蔬', stall: 'B档口' },
          ],
          archivedAt: Date.now(),
        },
        {
          date: testDate,
          meal: 'dinner',
          dishes: [
            { name: '麻辣香锅', stall: 'C档口', tags: ['辣'] },
          ],
          archivedAt: Date.now(),
        },
      ],
    };
    await writeFile(
      join(testDir, `${testYearMonth}.json`),
      JSON.stringify(archive, null, 2),
      'utf-8',
    );
  });

  afterEach(async () => {
    try {
      await rm(join(testDir, `${testYearMonth}.json`));
    } catch {
      // ignore
    }
  });

  it('按日期查询返回所有餐次', async () => {
    const result = await menuArchiveQueryTool.handler({ date: testDate });
    expect(result).toContain('红烧肉');
    expect(result).toContain('麻辣香锅');
    expect(result).toContain('午餐');
    expect(result).toContain('晚餐');
  });

  it('按日期+餐次过滤', async () => {
    const result = await menuArchiveQueryTool.handler({
      date: testDate,
      meal: 'lunch',
    });
    expect(result).toContain('红烧肉');
    expect(result).not.toContain('麻辣香锅');
  });

  it('按档口过滤', async () => {
    const result = await menuArchiveQueryTool.handler({
      date: testDate,
      stall: 'A档口',
    });
    expect(result).toContain('红烧肉');
    expect(result).not.toContain('清炒时蔬');
  });

  it('不存在的日期返回提示', async () => {
    const result = await menuArchiveQueryTool.handler({ date: '2099-02-01' });
    expect(result).toContain('没有菜品存档记录');
  });

  it('查询旧格式数据能正确归一化', async () => {
    // 写入一个旧格式的存档
    const legacyArchive = {
      '2099-02-11': {
        lunch: {
          dishes: [{ name: '旧格式菜', stall: '旧档口' }],
          restaurants: [],
        },
      },
    };
    await writeFile(
      join(testDir, `${testYearMonth}.json`),
      JSON.stringify(legacyArchive, null, 2),
      'utf-8',
    );

    const result = await menuArchiveQueryTool.handler({ date: '2099-02-11' });
    expect(result).toContain('旧格式菜');
    expect(result).toContain('旧档口');
  });
});

// ─── menuArchiveDiffTool ─────────────────────────────────────────────

describe('menuArchiveDiffTool.handler', () => {
  it('无历史数据时所有菜品均视为首次出现', async () => {
    const result = await menuArchiveDiffTool.handler({
      dishes: ['完全不存在的测试菜XYZ123', '另一道不存在的菜ABC456'],
      meal: 'breakfast',
      lookback_days: 1,
    });
    // breakfast 无历史数据，返回“所有 N 道菜品均视为首次出现”
    expect(result).toContain('暂无历史数据');
    expect(result).toContain('首次出现');
    expect(result).toContain('2');
  });

  it('空菜品列表返回提示', async () => {
    const result = await menuArchiveDiffTool.handler({
      dishes: [],
      meal: 'lunch',
    });
    expect(result).toContain('没有菜品数据');
  });
});
