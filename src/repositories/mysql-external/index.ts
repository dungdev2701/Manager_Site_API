import { MySQLClient } from '../../plugins/mysql';
import { EntityRequestRepository } from './entity-request.repo';
import { EntityLinkRepository } from './entity-link.repo';
import { ToolsRepository } from './tools.repo';

// Re-export types
export * from './types';

// Re-export repositories
export { EntityRequestRepository } from './entity-request.repo';
export { EntityLinkRepository } from './entity-link.repo';
export { ToolsRepository } from './tools.repo';

/**
 * Factory class để tạo tất cả MySQL repositories
 * Sử dụng khi cần tất cả repos cùng lúc
 */
export class MySQLExternalRepositories {
  public readonly entityRequest: EntityRequestRepository;
  public readonly entityLink: EntityLinkRepository;
  public readonly tools: ToolsRepository;

  constructor(mysql: MySQLClient) {
    this.entityRequest = new EntityRequestRepository(mysql);
    this.entityLink = new EntityLinkRepository(mysql);
    this.tools = new ToolsRepository(mysql);
  }
}
