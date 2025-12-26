import { RowDataPacket } from 'mysql2/promise';
import { MySQLClient } from '../../plugins/mysql';
import { Tool, ToolPair } from './types';

export class ToolsRepository {
  constructor(private mysql: MySQLClient) {}

  /**
   * Lấy tất cả tools đang running
   */
  async findRunning(): Promise<Tool[]> {
    return this.mysql.query<Tool[]>(
      "SELECT * FROM tools WHERE status = 'running'"
    );
  }

  /**
   * Lấy tool theo id_tool
   */
  async findById(idTool: string): Promise<Tool | null> {
    const rows = await this.mysql.query<Tool[]>(
      'SELECT * FROM tools WHERE id_tool = ?',
      [idTool]
    );
    return rows[0] || null;
  }

  /**
   * Kiểm tra tool có đang running không
   */
  async isRunning(idTool: string): Promise<boolean> {
    const rows = await this.mysql.query<Tool[]>(
      "SELECT * FROM tools WHERE id_tool = ? AND status = 'running'",
      [idTool]
    );
    return rows.length > 0;
  }

  /**
   * Lấy danh sách id_tool đang được sử dụng bởi các request đang running
   */
  async findInUse(): Promise<string[]> {
    const rows = await this.mysql.query<Array<RowDataPacket & { id_tool: string }>>(
      `SELECT DISTINCT id_tool FROM entity_request
       WHERE status = 'running'
       AND id_tool IS NOT NULL
       AND id_tool != ''`
    );
    return rows.map((r) => r.id_tool);
  }

  /**
   * Tìm cặp tool khả dụng (1 Normal + 1 Captcha đều running)
   */
  async findAvailablePair(): Promise<ToolPair | null> {
    const runningTools = await this.findRunning();
    const toolsInUse = await this.findInUse();

    // Parse các tool đang bận
    const busyTools = new Set<string>();
    for (const combined of toolsInUse) {
      const parts = combined.split(';').map((s) => s.trim());
      parts.forEach((tool) => busyTools.add(tool.toLowerCase()));
    }

    // Lọc ra các tools còn rảnh
    const availableTools = runningTools.filter(
      (t) => !busyTools.has(t.id_tool.toLowerCase())
    );

    // Phân loại tools
    const normalTools = availableTools.filter((t) =>
      t.id_tool.toLowerCase().startsWith('normal')
    );
    const captchaTools = availableTools.filter((t) =>
      t.id_tool.toLowerCase().startsWith('captcha')
    );

    if (normalTools.length === 0 || captchaTools.length === 0) {
      return null;
    }

    const normal = normalTools[0].id_tool;
    const captcha = captchaTools[0].id_tool;

    return {
      normal,
      captcha,
      combined: `${normal};${captcha}`,
    };
  }

  /**
   * Kiểm tra cặp tool có còn running không
   */
  async isPairRunning(combined: string): Promise<boolean> {
    const [normal, captcha] = combined.split(';').map((s) => s.trim());

    const rows = await this.mysql.query<Tool[]>(
      "SELECT * FROM tools WHERE id_tool IN (?, ?) AND status = 'running'",
      [normal, captcha]
    );

    return rows.length === 2;
  }
}
