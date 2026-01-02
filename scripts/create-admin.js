const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function createAdmin() {
  try {
    const hash = bcrypt.hashSync('admin123', 10);

    const user = await prisma.user.create({
      data: {
        id: 'admin-001',
        email: 'admin@likepion.com',
        password: hash,
        name: 'Admin',
        role: 'ADMIN',
        isActive: true,
        updatedAt: new Date()
      }
    });

    console.log('✅ User created successfully!');
    console.log('Email: admin@likepion.com');
    console.log('Password: admin123');
  } catch (error) {
    if (error.code === 'P2002') {
      console.log('⚠️ User already exists!');
    } else {
      console.error('❌ Error:', error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
