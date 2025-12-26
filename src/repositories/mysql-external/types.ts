import { RowDataPacket } from 'mysql2/promise';

// ==================== ENTITY REQUEST ====================

export type EntityRequestStatus = 'draft' | 'pending' | 'running' | 'connecting' | 'completed';

export interface EntityRequest extends RowDataPacket {
  id: number;
  userId: number;
  entity_email: string;
  app_password: string;
  id_tool: string | null;
  auction_price: number;
  entity_limit: number;
  username: string;
  website: string;
  fixed_sites: string | null;
  account_type: string;
  spin_content: string | null;
  entity_connect: string | null;
  social_connect: string | null;
  first_name: string;
  last_name: string;
  about: string | null;
  address: string | null;
  phone: string | null;
  location: string | null;
  status: EntityRequestStatus;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  checkedAt?: Date | null;
  is_delete: boolean;
  run_count: number;
  domains: string | null;
  data: string | null;
}

// ==================== ENTITY LINK ====================

// Các trạng thái của entity_link
export type EntityLinkStatus =
  | 'new'              // Mới tạo, chưa xử lý
  | 'registering'      // Đang đăng ký
  | 'profiling'        // Đang tạo profile
  | 'connecting'       // Đang kết nối
  | 'connect'          // Đã kết nối
  | 'finish'           // Hoàn thành
  | 'failed'           // Thất bại
  | 'cancel'           // Đã hủy
  | 'fail_registering' // Đăng ký thất bại (có thể retry)
  | 'fail_profiling';  // Tạo profile thất bại (có thể retry)

// Các status được coi là "đang xử lý"
export const PROCESSING_STATUSES: EntityLinkStatus[] = ['profiling', 'connecting', 'connect', 'registering'];

// Các status có thể retry
export const RETRYABLE_STATUSES: EntityLinkStatus[] = ['fail_registering', 'fail_profiling'];

export interface EntityLink extends RowDataPacket {
  id: string; // UUID
  entityRequestId: number;
  id_tool: string;
  email: string | null;
  username: string | null;
  password: string | null;
  about: string | null;
  site: string;
  link_profile: string | null;
  link_post: string | null;
  status: EntityLinkStatus;
  note: string | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  domains: string | null;
  index: number | null;
  type: string | null;
}

// ==================== TOOL ====================

export interface Tool extends RowDataPacket {
  id_tool: string;
  status: 'running' | 'die';
}

export interface ToolPair {
  normal: string;
  captcha: string;
  combined: string; // Format: "Normal 1;Captcha 1"
}

// ==================== INPUT TYPES ====================

export interface InsertEntityLinkInput {
  entityRequestId: number | string;
  email: string;
  username: string;
  about: string | null;
  site: string;
  accountType: string; // 'multiple' hoặc 'once'
  trafficType: 'normal' | 'captcha';
}

export interface LinkStatusCount {
  total: number;
  new: number;
  registering: number;
  profiling: number;
  connecting: number;
  connect: number;
  finish: number;
  failed: number;
  cancel: number;
  fail_registering: number;
  fail_profiling: number;
}
