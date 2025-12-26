/**
 * Script để cấp quyền ADMIN cho user
 * Usage: npx ts-node scripts/set-admin.ts
 */

import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function setAdminRole() {
  try {
    const email = 'admin@example.com';

    console.log(`🔍 Tìm user với email: ${email}...`);

    // Tìm user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      console.log(`❌ Không tìm thấy user với email: ${email}`);
      console.log(`💡 Hãy tạo user này bằng cách đăng ký hoặc chạy seed script`);
      return;
    }

    console.log(`✅ Tìm thấy user: ${user.name} (${user.email})`);
    console.log(`📋 Role hiện tại: ${user.role}`);

    if (user.role === Role.ADMIN) {
      console.log(`✅ User đã có quyền ADMIN rồi!`);
      return;
    }

    // Update role thành ADMIN
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: Role.ADMIN },
    });

    console.log(`✅ Đã cập nhật quyền ADMIN cho user: ${updated.name}`);
    console.log(`📋 Role mới: ${updated.role}`);
  } catch (error) {
    console.error('❌ Lỗi:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setAdminRole();
