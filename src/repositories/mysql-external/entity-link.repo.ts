import { RowDataPacket } from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import { MySQLClient } from '../../plugins/mysql';
import { EntityLink, EntityLinkStatus, InsertEntityLinkInput, LinkStatusCount } from './types';

// ==================== HELPER FUNCTIONS ====================

function generatePassword(): string {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';

  let password = '';
  for (let i = 0; i < 8; i++) {
    if (Math.random() > 0.5) {
      password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
    } else {
      password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
    }
  }

  password += '@';
  for (let i = 0; i < 3; i++) {
    password += numbers.charAt(Math.floor(Math.random() * numbers.length));
  }

  return password;
}

function modifyEmailWithDots(email: string): string {
  const [localPart, domain] = email.split('@');

  if (!localPart || localPart.length < 2 || !domain) {
    return email;
  }

  const maxDots = Math.min(3, Math.floor(localPart.length / 2));
  const numDots = Math.floor(Math.random() * maxDots) + 1;

  let modifiedLocal = localPart;
  const usedPositions = new Set<number>();

  for (let i = 0; i < numDots; i++) {
    let position: number;
    let attempts = 0;
    do {
      position = Math.floor(Math.random() * (modifiedLocal.length - 1)) + 1;
      attempts++;
    } while (
      (usedPositions.has(position) || modifiedLocal[position] === '.') &&
      attempts < 10
    );

    if (attempts < 10) {
      usedPositions.add(position);
      modifiedLocal = modifiedLocal.slice(0, position) + '.' + modifiedLocal.slice(position);
    }
  }

  return `${modifiedLocal}@${domain}`;
}

// ==================== REPOSITORY ====================

export class EntityLinkRepository {
  constructor(private mysql: MySQLClient) { }

  /**
   * Insert nhiều EntityLink (bulk insert)
   */
  async insertMany(links: InsertEntityLinkInput[]): Promise<number> {
    if (links.length === 0) return 0;

    const now = new Date();
    const values = links.map((link) => {
      const processedEmail = link.accountType === 'multiple'
        ? modifyEmailWithDots(link.email)
        : link.email;

      return [
        uuidv4(),
        link.entityRequestId,
        '',
        processedEmail,
        link.username,
        generatePassword(),
        link.about || '',
        link.site,
        '',
        '',
        'new',
        '',
        null,
        now,
        now,
        'likepion',
        0,
        link.trafficType,
      ];
    });

    const placeholders = links.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const flatValues = values.flat();

    const result = await this.mysql.execute(
      `INSERT INTO entity_link (
        id, entityRequestId, id_tool, email, username, password, about, site,
        link_profile, link_post, status, note, deletedAt, createdAt, updatedAt,
        domains, \`index\`, type
      ) VALUES ${placeholders}`,
      flatValues
    );

    return result.affectedRows;
  }

  /**
   * Lấy EntityLinks theo entityRequestId
   */
  async findByRequestId(entityRequestId: number | string): Promise<EntityLink[]> {
    return this.mysql.query<EntityLink[]>(
      'SELECT * FROM entity_link WHERE entityRequestId = ?',
      [entityRequestId]
    );
  }

  /**
   * Lấy EntityLinks đã hoàn thành (finish hoặc failed)
   */
  async findCompleted(entityRequestId: number | string): Promise<EntityLink[]> {
    return this.mysql.query<EntityLink[]>(
      `SELECT * FROM entity_link
       WHERE entityRequestId = ?
       AND status IN ('finish', 'failed')`,
      [entityRequestId]
    );
  }

  /**
   * Đếm số lượng EntityLink theo status
   */
  async countByStatus(entityRequestId: number | string): Promise<LinkStatusCount> {
    const rows = await this.mysql.query<
      Array<RowDataPacket & { status: string; count: number }>
    >(
      `SELECT status, COUNT(*) as count
       FROM entity_link
       WHERE entityRequestId = ?
       GROUP BY status`,
      [entityRequestId]
    );

    const result: LinkStatusCount = {
      total: 0,
      new: 0,
      registering: 0,
      profiling: 0,
      connecting: 0,
      connect: 0,
      finish: 0,
      failed: 0,
      cancel: 0,
      fail_registering: 0,
      fail_profiling: 0,
    };

    for (const row of rows) {
      if (row.status in result) {
        result[row.status as keyof Omit<LinkStatusCount, 'total'>] = row.count;
      }
      result.total += row.count;
    }
    return result;
  }

  /**
   * Kiểm tra xem có link nào đang ở trạng thái xử lý không
   * (profiling, connecting, connect, registering)
   */
  async hasProcessingLinks(entityRequestId: number | string): Promise<boolean> {
    const rows = await this.mysql.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) as count FROM entity_link
       WHERE entityRequestId = ?
       AND status IN ('connecting', 'connect')`,
      [entityRequestId]
    );
    return rows[0]?.count > 0;
  }

  /**
   * Cập nhật status hàng loạt cho các link theo điều kiện
   */
  async updateStatusBulk(
    entityRequestId: number | string,
    fromStatus: EntityLinkStatus,
    toStatus: EntityLinkStatus
  ): Promise<number> {
    const result = await this.mysql.execute(
      `UPDATE entity_link SET status = ? WHERE entityRequestId = ? AND status = ?`,
      [toStatus, entityRequestId, fromStatus]
    );
    return result.affectedRows;
  }

  /**
   * Cập nhật nhiều status cùng lúc trong 1 query
   * Sử dụng CASE WHEN để tối ưu, chỉ 1 roundtrip đến DB
   * Ví dụ: new -> cancel, finish -> connect khi timeout
   */
  async updateMultipleStatusBulk(
    entityRequestId: number | string,
    updates: Array<{ from: EntityLinkStatus; to: EntityLinkStatus }>
  ): Promise<number> {
    if (updates.length === 0) return 0;

    // Build CASE WHEN statement
    const caseStatements = updates.map(() => `WHEN status = ? THEN ?`).join(' ');
    const fromStatuses = updates.map((u) => u.from);
    const caseParams: (string | number)[] = [];
    for (const u of updates) {
      caseParams.push(u.from, u.to);
    }

    // Single UPDATE with CASE WHEN - chỉ 1 query
    const result = await this.mysql.execute(
      `UPDATE entity_link
       SET status = CASE ${caseStatements} ELSE status END
       WHERE entityRequestId = ? AND status IN (${fromStatuses.map(() => '?').join(', ')})`,
      [...caseParams, entityRequestId, ...fromStatuses]
    );

    return result.affectedRows;
  }

  /**
   * Đếm số lượng EntityLink theo status cho nhiều request cùng lúc
   * Chỉ 1 query cho tất cả requests
   */
  async countByStatusBatch(
    entityRequestIds: Array<number | string>
  ): Promise<Map<string, LinkStatusCount>> {
    if (entityRequestIds.length === 0) return new Map();

    const placeholders = entityRequestIds.map(() => '?').join(', ');
    const rows = await this.mysql.query<
      Array<RowDataPacket & { entityRequestId: string; status: string; count: number }>
    >(
      `SELECT entityRequestId, status, COUNT(*) as count
       FROM entity_link
       WHERE entityRequestId IN (${placeholders})
       GROUP BY entityRequestId, status`,
      entityRequestIds
    );

    const resultMap = new Map<string, LinkStatusCount>();

    // Initialize all request IDs with empty counts
    for (const id of entityRequestIds) {
      resultMap.set(String(id), {
        total: 0,
        new: 0,
        registering: 0,
        profiling: 0,
        connecting: 0,
        connect: 0,
        finish: 0,
        failed: 0,
        cancel: 0,
        fail_registering: 0,
        fail_profiling: 0,
      });
    }

    // Fill in counts from query results
    for (const row of rows) {
      const requestId = String(row.entityRequestId);
      const counts = resultMap.get(requestId);
      if (counts && row.status in counts) {
        counts[row.status as keyof Omit<LinkStatusCount, 'total'>] = row.count;
        counts.total += row.count;
      }
    }

    return resultMap;
  }

  /**
   * Kiểm tra xem có link nào đang ở trạng thái xử lý không cho nhiều request
   * Chỉ 1 query cho tất cả requests
   */
  async hasProcessingLinksBatch(
    entityRequestIds: Array<number | string>
  ): Promise<Map<string, boolean>> {
    if (entityRequestIds.length === 0) return new Map();

    const placeholders = entityRequestIds.map(() => '?').join(', ');
    const rows = await this.mysql.query<
      Array<RowDataPacket & { entityRequestId: string; count: number }>
    >(
      `SELECT entityRequestId, COUNT(*) as count
       FROM entity_link
       WHERE entityRequestId IN (${placeholders})
       AND status IN ('connecting', 'connect')
       GROUP BY entityRequestId`,
      entityRequestIds
    );

    const resultMap = new Map<string, boolean>();

    // Initialize all as false
    for (const id of entityRequestIds) {
      resultMap.set(String(id), false);
    }

    // Set true for those with processing links
    for (const row of rows) {
      if (row.count > 0) {
        resultMap.set(String(row.entityRequestId), true);
      }
    }

    return resultMap;
  }

  /**
   * Lấy danh sách link có thể retry (fail_registering, fail_profiling)
   * với số lần retry < maxRetry
   */
  async findRetryableLinks(
    entityRequestId: number | string,
    maxRetry: number
  ): Promise<EntityLink[]> {
    return this.mysql.query<EntityLink[]>(
      `SELECT * FROM entity_link
       WHERE entityRequestId = ?
       AND status IN ('fail_registering', 'fail_profiling')
       AND (\`index\` IS NULL OR \`index\` < ?)
       ORDER BY createdAt ASC`,
      [entityRequestId, maxRetry]
    );
  }

  /**
   * Retry các link failed bằng cách thêm dấu chấm vào email và reset status
   * Trả về số link đã được retry
   */
  async retryFailedLinks(linkIds: string[]): Promise<number> {
    if (linkIds.length === 0) return 0;

    // Lấy thông tin các link cần retry
    const placeholders = linkIds.map(() => '?').join(', ');
    const links = await this.mysql.query<EntityLink[]>(
      `SELECT id, email, \`index\` FROM entity_link WHERE id IN (${placeholders})`,
      linkIds
    );

    // Update từng link với email mới
    let updated = 0;
    for (const link of links) {
      if (!link.email) continue;

      // Thêm 1 dấu chấm ngẫu nhiên vào email
      const newEmail = this.addRandomDotToEmail(link.email);
      const newIndex = (link.index || 0) + 1;

      await this.mysql.execute(
        `UPDATE entity_link
         SET email = ?, status = 'new', \`index\` = ?, updatedAt = NOW()
         WHERE id = ?`,
        [newEmail, newIndex, link.id]
      );
      updated++;
    }

    return updated;
  }

  /**
   * Thêm 1 dấu chấm ngẫu nhiên vào email
   */
  private addRandomDotToEmail(email: string): string {
    const [localPart, domain] = email.split('@');

    if (!localPart || localPart.length < 2 || !domain) {
      return email;
    }

    // Tìm vị trí có thể chèn dấu chấm (không phải đầu, không phải sau dấu chấm đã có)
    const validPositions: number[] = [];
    for (let i = 1; i < localPart.length; i++) {
      if (localPart[i] !== '.' && localPart[i - 1] !== '.') {
        validPositions.push(i);
      }
    }

    if (validPositions.length === 0) {
      return email; // Không thể thêm dấu chấm
    }

    // Chọn vị trí ngẫu nhiên
    const position = validPositions[Math.floor(Math.random() * validPositions.length)];
    const newLocalPart = localPart.slice(0, position) + '.' + localPart.slice(position);

    return `${newLocalPart}@${domain}`;
  }

  /**
   * Lấy danh sách site đã được phân bổ cho request
   */
  async getAllocatedSites(entityRequestId: number | string): Promise<string[]> {
    const rows = await this.mysql.query<Array<RowDataPacket & { site: string }>>(
      `SELECT DISTINCT site FROM entity_link WHERE entityRequestId = ?`,
      [entityRequestId]
    );
    return rows.map((r) => r.site);
  }
}
