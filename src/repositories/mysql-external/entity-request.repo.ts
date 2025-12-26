import { MySQLClient } from '../../plugins/mysql';
import { EntityRequest, EntityRequestStatus } from './types';

export class EntityRequestRepository {
  constructor(private mysql: MySQLClient) {}

  /**
   * Lấy danh sách EntityRequest đang pending và chưa được assign tool
   */
  async findPendingWithoutTool(): Promise<EntityRequest[]> {
    return this.mysql.query<EntityRequest[]>(
      `SELECT * FROM entity_request
       WHERE status = 'pending'
       AND (id_tool IS NULL OR id_tool = '')
       ORDER BY id ASC`
    );
  }

  /**
   * Lấy EntityRequest theo ID
   */
  async findById(id: number | string): Promise<EntityRequest | null> {
    const rows = await this.mysql.query<EntityRequest[]>(
      'SELECT * FROM entity_request WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Lấy danh sách EntityRequest đang running
   */
  async findRunning(): Promise<EntityRequest[]> {
    return this.mysql.query<EntityRequest[]>(
      `SELECT * FROM entity_request
       WHERE status = 'running'
       ORDER BY createdAt ASC`
    );
  }

  /**
   * Lấy danh sách EntityRequest đang connecting
   */
  async findConnecting(): Promise<EntityRequest[]> {
    return this.mysql.query<EntityRequest[]>(
      `SELECT * FROM entity_request
       WHERE status = 'connecting'
       ORDER BY createdAt ASC`
    );
  }

  /**
   * Update id_tool và status cho EntityRequest
   */
  async updateTool(
    id: number | string,
    idTool: string,
    status: EntityRequestStatus = 'running'
  ): Promise<void> {
    await this.mysql.execute(
      'UPDATE entity_request SET id_tool = ?, status = ? WHERE id = ?',
      [idTool, status, id]
    );
  }

  /**
   * Update status của EntityRequest
   */
  async updateStatus(
    id: number | string,
    status: EntityRequestStatus
  ): Promise<void> {
    await this.mysql.execute(
      'UPDATE entity_request SET status = ? WHERE id = ?',
      [status, id]
    );
  }

  /**
   * Tính thời gian timeout dựa trên entity_limit
   * - < 100: 30 phút
   * - 100: 35 phút
   * - 200: 70 phút
   * - 300: 105 phút
   * - 400: 140 phút
   * Formula: Math.ceil(entity_limit / 100) * 35 phút (tối thiểu 30 phút)
   */
  static calculateTimeoutMinutes(entityLimit: number): number {
    if (entityLimit < 100) return 30;
    return Math.ceil(entityLimit / 100) * 35;
  }

  /**
   * Kiểm tra request đã quá thời gian chạy chưa
   */
  isRequestTimedOut(request: EntityRequest): boolean {
    if (!request.updatedAt) return false;

    const timeoutMinutes = EntityRequestRepository.calculateTimeoutMinutes(request.entity_limit);
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const elapsed = Date.now() - new Date(request.updatedAt).getTime();

    return elapsed > timeoutMs;
  }
}
