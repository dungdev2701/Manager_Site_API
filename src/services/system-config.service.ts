import { FastifyInstance } from 'fastify';
import { ConfigType } from '@prisma/client';

// ==================== TYPES ====================

export interface SystemConfigValue {
  key: string;
  value: string;
  type: ConfigType;
  description?: string | null;
  parsedValue: unknown;
  updatedAt: Date;
  updatedBy?: string | null;
}

export interface CreateConfigInput {
  key: string;
  value: string;
  type?: ConfigType;
  description?: string;
}

export interface UpdateConfigInput {
  value: string;
  description?: string;
  updatedBy?: string;
}

// ==================== DEFAULT CONFIGS ====================

const DEFAULT_CONFIGS: Record<string, { value: string; type: ConfigType; description: string }> = {
  ALLOCATION_MULTIPLIER: {
    value: '2.5',
    type: 'NUMBER',
    description: 'Hệ số nhân phân bổ website. VD: entityLimit=100 sẽ phân bổ 250 websites (100*2.5)',
  },
  CLAIM_TIMEOUT_MINUTES: {
    value: '5',
    type: 'NUMBER',
    description: 'Thời gian timeout (phút) cho mỗi task đã claim. Sau thời gian này task sẽ được release.',
  },
  MAX_DAILY_ALLOCATIONS: {
    value: '3',
    type: 'NUMBER',
    description: 'Số lần tối đa một website được phân bổ trong ngày',
  },
  TRAFFIC_THRESHOLD: {
    value: '50000',
    type: 'NUMBER',
    description: 'Ngưỡng traffic để phân loại HIGH/LOW. >= threshold = HIGH',
  },
  MAX_RETRY_COUNT: {
    value: '5',
    type: 'NUMBER',
    description: 'Số lần retry tối đa cho một task thất bại',
  },
  REALLOCATION_ENABLED: {
    value: 'true',
    type: 'BOOLEAN',
    description: 'Bật/tắt chức năng phân bổ bổ sung tự động',
  },
  MAX_BATCHES_PER_REQUEST: {
    value: '3',
    type: 'NUMBER',
    description: 'Số batch tối đa cho mỗi request trước khi check email/password',
  },
  EMAIL_RETRY_MODIFICATION: {
    value: 'true',
    type: 'BOOLEAN',
    description: 'Bật/tắt việc thêm dấu chấm vào email khi retry failed tasks',
  },
};

// ==================== SERVICE ====================

/**
 * Service quản lý SystemConfig
 *
 * Cho phép:
 * - Get/Set config values
 * - Initialize default configs
 * - Parse values theo type (NUMBER, BOOLEAN, JSON, STRING)
 */
export class SystemConfigService {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Parse config value theo type
   */
  private parseValue(value: string, type: ConfigType): unknown {
    switch (type) {
      case 'NUMBER':
        return Number(value);
      case 'BOOLEAN':
        return value.toLowerCase() === 'true';
      case 'JSON':
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      default:
        return value;
    }
  }

  /**
   * Get config by key
   */
  async get(key: string): Promise<SystemConfigValue | null> {
    const config = await this.fastify.prisma.systemConfig.findUnique({
      where: { key },
    });

    if (!config) {
      // Return default if exists
      const defaultConfig = DEFAULT_CONFIGS[key];
      if (defaultConfig) {
        return {
          key,
          value: defaultConfig.value,
          type: defaultConfig.type,
          description: defaultConfig.description,
          parsedValue: this.parseValue(defaultConfig.value, defaultConfig.type),
          updatedAt: new Date(),
          updatedBy: null,
        };
      }
      return null;
    }

    return {
      key: config.key,
      value: config.value,
      type: config.type,
      description: config.description,
      parsedValue: this.parseValue(config.value, config.type),
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    };
  }

  /**
   * Get config value với type safety
   */
  async getValue<T>(key: string, defaultValue: T): Promise<T> {
    const config = await this.get(key);
    if (!config) return defaultValue;
    return config.parsedValue as T;
  }

  /**
   * Get multiple configs
   */
  async getMany(keys: string[]): Promise<Record<string, SystemConfigValue>> {
    const configs = await this.fastify.prisma.systemConfig.findMany({
      where: { key: { in: keys } },
    });

    const result: Record<string, SystemConfigValue> = {};

    for (const key of keys) {
      const config = configs.find((c) => c.key === key);
      if (config) {
        result[key] = {
          key: config.key,
          value: config.value,
          type: config.type,
          description: config.description,
          parsedValue: this.parseValue(config.value, config.type),
          updatedAt: config.updatedAt,
          updatedBy: config.updatedBy,
        };
      } else {
        // Return default if exists
        const defaultConfig = DEFAULT_CONFIGS[key];
        if (defaultConfig) {
          result[key] = {
            key,
            value: defaultConfig.value,
            type: defaultConfig.type,
            description: defaultConfig.description,
            parsedValue: this.parseValue(defaultConfig.value, defaultConfig.type),
            updatedAt: new Date(),
            updatedBy: null,
          };
        }
      }
    }

    return result;
  }

  /**
   * Get all configs
   */
  async getAll(): Promise<SystemConfigValue[]> {
    const configs = await this.fastify.prisma.systemConfig.findMany({
      orderBy: { key: 'asc' },
    });

    // Merge with defaults
    const result: Record<string, SystemConfigValue> = {};

    // Add defaults first
    for (const [key, config] of Object.entries(DEFAULT_CONFIGS)) {
      result[key] = {
        key,
        value: config.value,
        type: config.type,
        description: config.description,
        parsedValue: this.parseValue(config.value, config.type),
        updatedAt: new Date(),
        updatedBy: null,
      };
    }

    // Override with actual configs
    for (const config of configs) {
      result[config.key] = {
        key: config.key,
        value: config.value,
        type: config.type,
        description: config.description,
        parsedValue: this.parseValue(config.value, config.type),
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy,
      };
    }

    return Object.values(result);
  }

  /**
   * Set config value
   */
  async set(key: string, input: UpdateConfigInput): Promise<SystemConfigValue> {
    // Determine type from default or existing
    let type: ConfigType = 'STRING';
    const defaultConfig = DEFAULT_CONFIGS[key];
    if (defaultConfig) {
      type = defaultConfig.type;
    } else {
      const existing = await this.fastify.prisma.systemConfig.findUnique({
        where: { key },
      });
      if (existing) {
        type = existing.type;
      }
    }

    // Validate value based on type
    const parsedValue = this.parseValue(input.value, type);
    if (type === 'NUMBER' && isNaN(parsedValue as number)) {
      throw this.fastify.httpErrors.badRequest(`Invalid number value for key '${key}'`);
    }
    if (type === 'JSON' && parsedValue === null) {
      throw this.fastify.httpErrors.badRequest(`Invalid JSON value for key '${key}'`);
    }

    const config = await this.fastify.prisma.systemConfig.upsert({
      where: { key },
      create: {
        key,
        value: input.value,
        type,
        description: input.description || defaultConfig?.description,
        updatedBy: input.updatedBy,
      },
      update: {
        value: input.value,
        description: input.description,
        updatedBy: input.updatedBy,
      },
    });

    return {
      key: config.key,
      value: config.value,
      type: config.type,
      description: config.description,
      parsedValue: this.parseValue(config.value, config.type),
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    };
  }

  /**
   * Create new config
   */
  async create(input: CreateConfigInput): Promise<SystemConfigValue> {
    const existing = await this.fastify.prisma.systemConfig.findUnique({
      where: { key: input.key },
    });

    if (existing) {
      throw this.fastify.httpErrors.conflict(`Config with key '${input.key}' already exists`);
    }

    const type = input.type || 'STRING';
    const config = await this.fastify.prisma.systemConfig.create({
      data: {
        key: input.key,
        value: input.value,
        type,
        description: input.description,
      },
    });

    return {
      key: config.key,
      value: config.value,
      type: config.type,
      description: config.description,
      parsedValue: this.parseValue(config.value, config.type),
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    };
  }

  /**
   * Delete config
   */
  async delete(key: string): Promise<boolean> {
    const existing = await this.fastify.prisma.systemConfig.findUnique({
      where: { key },
    });

    if (!existing) {
      return false;
    }

    await this.fastify.prisma.systemConfig.delete({
      where: { key },
    });

    return true;
  }

  /**
   * Initialize default configs
   * Called on app startup to ensure all default configs exist
   */
  async initializeDefaults(): Promise<number> {
    let created = 0;

    for (const [key, config] of Object.entries(DEFAULT_CONFIGS)) {
      const existing = await this.fastify.prisma.systemConfig.findUnique({
        where: { key },
      });

      if (!existing) {
        await this.fastify.prisma.systemConfig.create({
          data: {
            key,
            value: config.value,
            type: config.type,
            description: config.description,
          },
        });
        created++;
      }
    }

    if (created > 0) {
      this.fastify.log.info({ created }, 'Initialized default system configs');
    }

    return created;
  }

  /**
   * Reset config to default
   */
  async resetToDefault(key: string): Promise<SystemConfigValue | null> {
    const defaultConfig = DEFAULT_CONFIGS[key];
    if (!defaultConfig) {
      return null;
    }

    return this.set(key, {
      value: defaultConfig.value,
      description: defaultConfig.description,
    });
  }

  /**
   * Reset all configs to defaults
   */
  async resetAllToDefaults(): Promise<number> {
    let reset = 0;

    for (const [key, config] of Object.entries(DEFAULT_CONFIGS)) {
      await this.fastify.prisma.systemConfig.upsert({
        where: { key },
        create: {
          key,
          value: config.value,
          type: config.type,
          description: config.description,
        },
        update: {
          value: config.value,
          type: config.type,
          description: config.description,
        },
      });
      reset++;
    }

    return reset;
  }
}
