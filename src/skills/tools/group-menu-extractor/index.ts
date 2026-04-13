/**
 * group-menu-extractor Skill 专属工具
 *
 * 提供菜品历史记录的持久化存储，支持按日期存档、查询历史和新品检测。
 * 数据以 JSON 文件按年月分片存储在 .fan_bot/skills/group-menu-extractor/archive/ 目录中。
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Tool } from '../../../tools/types.js';
import { createDebug } from '../../../utils/debug.js';

const log = createDebug('skills:menu-archive');

const ARCHIVE_DIR = '.fan_bot/skills/group-menu-extractor/archive';

interface MenuDish {
  name: string;
  stall: string;
  price?: string;
  tags?: string[];
}

interface DailyMenuRecord {
  date: string;
  meal: 'lunch' | 'dinner';
  dishes: MenuDish[];
  archivedAt: number;
}

interface MonthlyArchive {
  [dateKey: string]: DailyMenuRecord[];
}

/**
 * 获取月度存档文件路径
 */
function getArchivePath(yearMonth: string): string {
  return join(ARCHIVE_DIR, `${yearMonth}.json`);
}

/**
 * 读取月度存档
 */
async function loadMonthlyArchive(yearMonth: string): Promise<MonthlyArchive> {
  try {
    const content = await readFile(getArchivePath(yearMonth), 'utf-8');
    return JSON.parse(content) as MonthlyArchive;
  } catch {
    return {};
  }
}

/**
 * 保存月度存档
 */
async function saveMonthlyArchive(
  yearMonth: string,
  archive: MonthlyArchive,
): Promise<void> {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await writeFile(
    getArchivePath(yearMonth),
    JSON.stringify(archive, null, 2),
    'utf-8',
  );
}

/**
 * 获取最近 N 天的所有菜品名称集合（用于新品检测）
 */
async function getRecentDishNames(
  days: number,
  meal?: 'lunch' | 'dinner',
): Promise<Set<string>> {
  const names = new Set<string>();
  const today = new Date();

  const monthsToCheck = new Set<string>();
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    monthsToCheck.add(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    );
  }

  for (const ym of monthsToCheck) {
    const archive = await loadMonthlyArchive(ym);
    for (const records of Object.values(archive)) {
      for (const record of records) {
        if (meal && record.meal !== meal) continue;

        const recordDate = new Date(record.date);
        const diffDays = Math.floor(
          (today.getTime() - recordDate.getTime()) / 86400000,
        );
        if (diffDays >= 1 && diffDays <= days) {
          for (const dish of record.dishes) {
            names.add(dish.name.trim().toLowerCase());
          }
        }
      }
    }
  }

  return names;
}

/**
 * menu_archive_save 工具
 *
 * 存档今日菜品信息。Agent 在提取完菜单后调用此工具，将菜品数据持久化。
 */
export const menuArchiveSaveTool: Tool = {
  schema: {
    name: 'menu_archive_save',
    description:
      '存档今日菜品信息。在提取完菜单后调用，将菜品数据持久化存储，用于后续新品检测和历史查询。',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: '日期，格式 YYYY-MM-DD，默认今天',
        },
        meal: {
          type: 'string',
          enum: ['lunch', 'dinner'],
          description: '餐次：lunch 或 dinner',
        },
        dishes: {
          type: 'array',
          description: '菜品列表',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: '菜品名称',
              },
              stall: {
                type: 'string',
                description: '档口/餐厅名称',
              },
              price: {
                type: 'string',
                description: '价格（如 "¥32"）',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: '标签（如 ["新品", "限时", "特价"]）',
              },
            },
            required: ['name', 'stall'],
          },
        },
      },
      required: ['meal', 'dishes'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const now = new Date();
    const date =
      (input.date as string) ||
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const meal = input.meal as 'lunch' | 'dinner';
    const dishes = input.dishes as MenuDish[];

    if (!dishes || dishes.length === 0) {
      return '没有菜品数据需要存档。';
    }

    const yearMonth = date.slice(0, 7);
    const archive = await loadMonthlyArchive(yearMonth);

    const record: DailyMenuRecord = {
      date,
      meal,
      dishes,
      archivedAt: Date.now(),
    };

    if (!archive[date]) {
      archive[date] = [];
    }

    const existingIndex = archive[date].findIndex((r) => r.meal === meal);
    if (existingIndex >= 0) {
      archive[date][existingIndex] = record;
      log.info(
        `Updated menu archive: ${date} ${meal} (${dishes.length} dishes)`,
      );
    } else {
      archive[date].push(record);
      log.info(
        `Created menu archive: ${date} ${meal} (${dishes.length} dishes)`,
      );
    }

    await saveMonthlyArchive(yearMonth, archive);

    return `已存档 ${date} ${meal === 'lunch' ? '午餐' : '晚餐'} ${dishes.length} 道菜品。`;
  },

  riskLevel: 'low',
  requiresConfirmation: false,
};

/**
 * menu_archive_diff 工具
 *
 * 对比今日菜品与历史记录，识别新品和消失的菜品。
 */
export const menuArchiveDiffTool: Tool = {
  schema: {
    name: 'menu_archive_diff',
    description:
      '对比今日菜品与历史记录，识别首次出现的新品和近期消失的菜品。用于在菜单推送中标注"首次出现"。',
    input_schema: {
      type: 'object',
      properties: {
        dishes: {
          type: 'array',
          description: '今日菜品名称列表',
          items: { type: 'string' },
        },
        meal: {
          type: 'string',
          enum: ['lunch', 'dinner'],
          description: '餐次',
        },
        lookback_days: {
          type: 'number',
          description: '回溯天数（默认 7 天）',
        },
      },
      required: ['dishes', 'meal'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const todayDishes = input.dishes as string[];
    const meal = input.meal as 'lunch' | 'dinner';
    const lookbackDays = Number(input.lookback_days) || 7;

    if (!todayDishes || todayDishes.length === 0) {
      return '没有菜品数据可供对比。';
    }

    const recentNames = await getRecentDishNames(lookbackDays, meal);

    const newDishes: string[] = [];

    for (const dish of todayDishes) {
      const normalized = dish.trim().toLowerCase();
      if (!recentNames.has(normalized)) {
        newDishes.push(dish);
      }
    }

    if (recentNames.size === 0) {
      return `暂无历史数据可供对比（过去 ${lookbackDays} 天无${meal === 'lunch' ? '午餐' : '晚餐'}记录）。所有 ${todayDishes.length} 道菜品均视为首次出现。`;
    }

    const recentArray = [...recentNames];
    const returningDishes: string[] = [];
    for (const name of recentArray) {
      const stillExists = todayDishes.some(
        (d) => d.trim().toLowerCase() === name,
      );
      if (!stillExists) {
        returningDishes.push(name);
      }
    }

    const lines: string[] = [];
    lines.push(
      `对比范围：过去 ${lookbackDays} 天的${meal === 'lunch' ? '午餐' : '晚餐'}记录（历史菜品 ${recentNames.size} 道）`,
    );

    if (newDishes.length > 0) {
      lines.push(`\n🆕 首次出现（${newDishes.length} 道）：`);
      for (const dish of newDishes) {
        lines.push(`  - ${dish}`);
      }
    } else {
      lines.push('\n✅ 今日无新品，所有菜品近期都出现过。');
    }

    if (returningDishes.length > 0 && returningDishes.length <= 10) {
      lines.push(`\n👋 近期有但今日没出现（${returningDishes.length} 道）：`);
      for (const dish of returningDishes.slice(0, 10)) {
        lines.push(`  - ${dish}`);
      }
    }

    return lines.join('\n');
  },

  riskLevel: 'low',
  requiresConfirmation: false,
};

/**
 * menu_archive_query 工具
 *
 * 查询历史菜品记录。
 */
export const menuArchiveQueryTool: Tool = {
  schema: {
    name: 'menu_archive_query',
    description:
      '查询历史菜品记录。可按日期、餐次、档口、菜品名称查询。支持查看某道菜最近出现的日期、某个档口的菜品变化等。',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: '查询指定日期的菜品（格式 YYYY-MM-DD）',
        },
        meal: {
          type: 'string',
          enum: ['lunch', 'dinner'],
          description: '餐次过滤',
        },
        stall: {
          type: 'string',
          description: '按档口名称过滤（模糊匹配）',
        },
        dish_name: {
          type: 'string',
          description: '按菜品名称搜索（模糊匹配），返回该菜品最近出现的记录',
        },
        days: {
          type: 'number',
          description: '查询最近 N 天的记录（默认 7），与 date 互斥',
        },
      },
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const targetDate = input.date as string | undefined;
    const meal = input.meal as 'lunch' | 'dinner' | undefined;
    const stallFilter = input.stall as string | undefined;
    const dishNameFilter = input.dish_name as string | undefined;
    const days = Number(input.days) || 7;

    if (targetDate) {
      const yearMonth = targetDate.slice(0, 7);
      const archive = await loadMonthlyArchive(yearMonth);
      const records = archive[targetDate];

      if (!records || records.length === 0) {
        return `${targetDate} 没有菜品存档记录。`;
      }

      const filtered = meal ? records.filter((r) => r.meal === meal) : records;
      return formatRecords(filtered, stallFilter, dishNameFilter);
    }

    const allRecords: DailyMenuRecord[] = [];
    const today = new Date();
    const monthsToCheck = new Set<string>();

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      monthsToCheck.add(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      );
    }

    for (const ym of monthsToCheck) {
      const archive = await loadMonthlyArchive(ym);
      for (const records of Object.values(archive)) {
        for (const record of records) {
          const recordDate = new Date(record.date);
          const diffDays = Math.floor(
            (today.getTime() - recordDate.getTime()) / 86400000,
          );
          if (diffDays >= 0 && diffDays < days) {
            if (meal && record.meal !== meal) continue;
            allRecords.push(record);
          }
        }
      }
    }

    if (allRecords.length === 0) {
      return `最近 ${days} 天没有菜品存档记录。`;
    }

    allRecords.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    if (dishNameFilter) {
      const keyword = dishNameFilter.toLowerCase();
      const appearances: Array<{
        date: string;
        meal: string;
        stall: string;
        name: string;
      }> = [];

      for (const record of allRecords) {
        for (const dish of record.dishes) {
          if (dish.name.toLowerCase().includes(keyword)) {
            appearances.push({
              date: record.date,
              meal: record.meal === 'lunch' ? '午餐' : '晚餐',
              stall: dish.stall,
              name: dish.name,
            });
          }
        }
      }

      if (appearances.length === 0) {
        return `最近 ${days} 天未找到包含"${dishNameFilter}"的菜品。`;
      }

      const lines = [
        `"${dishNameFilter}" 最近 ${days} 天出现 ${appearances.length} 次：`,
      ];
      for (const a of appearances.slice(0, 20)) {
        lines.push(`  - ${a.date} ${a.meal} @ ${a.stall}：${a.name}`);
      }
      return lines.join('\n');
    }

    return formatRecords(allRecords, stallFilter);
  },

  riskLevel: 'low',
  requiresConfirmation: false,
};

/**
 * 格式化菜品记录为可读文本
 */
function formatRecords(
  records: DailyMenuRecord[],
  stallFilter?: string,
  dishNameFilter?: string,
): string {
  const lines: string[] = [];

  for (const record of records) {
    let dishes = record.dishes;

    if (stallFilter) {
      const keyword = stallFilter.toLowerCase();
      dishes = dishes.filter((d) => d.stall.toLowerCase().includes(keyword));
    }

    if (dishNameFilter) {
      const keyword = dishNameFilter.toLowerCase();
      dishes = dishes.filter((d) => d.name.toLowerCase().includes(keyword));
    }

    if (dishes.length === 0) continue;

    lines.push(
      `\n📅 ${record.date} ${record.meal === 'lunch' ? '午餐' : '晚餐'}（${dishes.length} 道）`,
    );

    const byStall = new Map<string, MenuDish[]>();
    for (const dish of dishes) {
      const stall = dish.stall || '未知档口';
      if (!byStall.has(stall)) byStall.set(stall, []);
      byStall.get(stall)!.push(dish);
    }

    for (const [stall, stallDishes] of byStall) {
      const dishTexts = stallDishes.map((d) => {
        let text = d.name;
        if (d.price) text += ` ${d.price}`;
        if (d.tags && d.tags.length > 0) text += ` [${d.tags.join(', ')}]`;
        return text;
      });
      lines.push(`  📍 ${stall}：${dishTexts.join('、')}`);
    }
  }

  if (lines.length === 0) {
    return '没有匹配的菜品记录。';
  }

  return lines.join('\n').trim();
}

/**
 * 此 Skill 提供的所有工具
 */
export const tools: Tool[] = [
  menuArchiveSaveTool,
  menuArchiveDiffTool,
  menuArchiveQueryTool,
];
