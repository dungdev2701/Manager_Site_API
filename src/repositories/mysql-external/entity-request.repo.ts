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
   * Kiểm tra request đã quá thời gian chạy chưa (cho phase RUNNING)
   */
  isRequestTimedOut(request: EntityRequest): boolean {
    if (!request.updatedAt) return false;

    const timeoutMinutes = EntityRequestRepository.calculateTimeoutMinutes(request.entity_limit);
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const elapsed = Date.now() - new Date(request.updatedAt).getTime();

    return elapsed > timeoutMs;
  }

  /**
   * Tính thời gian timeout tổng bao gồm cả connecting phase
   * Total timeout = running timeout + connecting timeout
   * Connecting timeout = running timeout / 6
   * => Total timeout = running timeout * 7/6
   */
  static calculateTotalTimeoutMinutes(entityLimit: number): number {
    const runningTimeout = EntityRequestRepository.calculateTimeoutMinutes(entityLimit);
    // Connecting phase = 1/6 của running timeout
    // Total = running + connecting = running * (1 + 1/6) = running * 7/6
    return Math.ceil(runningTimeout * 7 / 6);
  }

  /**
   * Tính thời gian connecting timeout riêng (1/6 của running timeout)
   */
  static calculateConnectingTimeoutMinutes(entityLimit: number): number {
    const runningTimeout = EntityRequestRepository.calculateTimeoutMinutes(entityLimit);
    return Math.ceil(runningTimeout / 6);
  }

  /**
   * Kiểm tra request đang ở phase CONNECTING đã quá timeout chưa
   * Timeout connecting = 1/6 thời gian timeout gốc
   * Tính từ thời điểm updatedAt (lúc chuyển sang connecting)
   */
  isConnectingTimedOut(request: EntityRequest): boolean {
    if (!request.updatedAt || request.status !== 'connecting') return false;

    const connectingTimeoutMinutes = EntityRequestRepository.calculateConnectingTimeoutMinutes(request.entity_limit);
    const connectingTimeoutMs = connectingTimeoutMinutes * 60 * 1000;
    const elapsed = Date.now() - new Date(request.updatedAt).getTime();

    return elapsed > connectingTimeoutMs;
  }

  /**
   * Lấy nhiều EntityRequest theo danh sách IDs (batch query)
   */
  async findByIds(ids: (number | string)[]): Promise<EntityRequest[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    return this.mysql.query<EntityRequest[]>(
      `SELECT * FROM entity_request WHERE id IN (${placeholders})`,
      ids
    );
  }

  /**
   * Lấy danh sách EntityRequest đã completed
   */
  async findCompleted(): Promise<EntityRequest[]> {
    return this.mysql.query<EntityRequest[]>(
      `SELECT * FROM entity_request WHERE status = 'completed' ORDER BY updatedAt DESC`
    );
  }
}
