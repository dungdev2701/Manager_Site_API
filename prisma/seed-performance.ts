import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Helper functions to replace date-fns
function subDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}

function addHours(date: Date, hours: number): Date {
  const result = new Date(date);
  result.setHours(result.getHours() + hours);
  return result;
}

async function main() {
  console.log('Starting performance data seeding...');

  // Get some websites to seed data for
  const websites = await prisma.website.findMany({
    take: 10,
    where: {
      deletedAt: null,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (websites.length === 0) {
    console.log('No websites found. Please create some websites first.');
    return;
  }

  console.log(`Found ${websites.length} websites to seed performance data for.`);

  // Get some users for audit logs
  const users = await prisma.user.findMany({
    take: 5,
  });

  if (users.length === 0) {
    console.log('No users found. Please create some users first.');
    return;
  }

  console.log(`Found ${users.length} users to use for audit logs.`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Seed data for the last 60 days
  const daysToSeed = 60;

  for (const website of websites) {
    console.log(`\nSeeding data for website: ${website.domain}`);

    // Clear existing data for this website
    await prisma.dailyAllocation.deleteMany({
      where: { websiteId: website.id },
    });

    await prisma.auditLog.deleteMany({
      where: {
        entity: 'Website',
        entityId: website.id,
      },
    });

    // Generate daily allocation data
    let baseSuccessRate = 50 + Math.random() * 40; // Start with 50-90% success rate
    const dailyAllocations = [];

    for (let i = daysToSeed; i >= 0; i--) {
      const date = subDays(today, i);

      // Random chance of having allocations on this day (80% chance)
      if (Math.random() > 0.2) {
        // Random number of allocations (5-50 per day)
        const allocationCount = Math.floor(5 + Math.random() * 45);

        // Calculate success/failure based on current success rate
        // Add some variation
        const dailySuccessRate = Math.min(100, Math.max(0, baseSuccessRate + (Math.random() * 20 - 10)));
        const successCount = Math.round((dailySuccessRate / 100) * allocationCount);
        const failureCount = allocationCount - successCount;

        dailyAllocations.push({
          websiteId: website.id,
          date,
          allocationCount,
          successCount,
          failureCount,
        });

        // Gradually improve success rate over time (simulating optimization)
        baseSuccessRate = Math.min(95, baseSuccessRate + Math.random() * 0.5);
      }
    }

    // Batch insert daily allocations
    if (dailyAllocations.length > 0) {
      await prisma.dailyAllocation.createMany({
        data: dailyAllocations,
      });
      console.log(`  Created ${dailyAllocations.length} daily allocation records`);
    }

    // Generate audit logs (edits) - random edits spread across the period
    const numberOfEdits = Math.floor(3 + Math.random() * 8); // 3-10 edits per website
    const auditLogs = [];

    for (let j = 0; j < numberOfEdits; j++) {
      // Random day within the period
      const daysAgo = Math.floor(Math.random() * daysToSeed);
      const editDate = subDays(today, daysAgo);
      // Add random hours
      const editDateTime = addHours(editDate, Math.floor(Math.random() * 24));

      // Random user
      const user = users[Math.floor(Math.random() * users.length)];

      // Random changes
      const possibleChanges = [
        { field: 'status', oldValue: 'CHECKING', newValue: 'RUNNING' },
        { field: 'status', oldValue: 'NEW', newValue: 'CHECKING' },
        { field: 'status', oldValue: 'ERROR', newValue: 'RUNNING' },
        { field: 'notes', oldValue: '', newValue: 'Updated configuration' },
        { field: 'notes', oldValue: 'Testing', newValue: 'Verified and working' },
        { field: 'metrics.captcha_type', oldValue: 'captcha', newValue: 'normal' },
        { field: 'metrics.verify', oldValue: 'no', newValue: 'yes' },
        { field: 'priority', oldValue: '0', newValue: '5' },
      ];

      const change = possibleChanges[Math.floor(Math.random() * possibleChanges.length)];

      auditLogs.push({
        userId: user.id,
        action: 'UPDATE',
        entity: 'Website',
        entityId: website.id,
        oldValues: { [change.field]: change.oldValue },
        newValues: { [change.field]: change.newValue },
        ipAddress: '192.168.1.' + Math.floor(Math.random() * 255),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        createdAt: editDateTime,
      });
    }

    // Batch insert audit logs
    if (auditLogs.length > 0) {
      await prisma.auditLog.createMany({
        data: auditLogs,
      });
      console.log(`  Created ${auditLogs.length} audit log (edit) records`);
    }

    // Log summary for this website
    const recentAllocations = dailyAllocations.slice(-30); // Last 30 days
    const totalAttempts = recentAllocations.reduce((sum, d) => sum + d.allocationCount, 0);
    const totalSuccess = recentAllocations.reduce((sum, d) => sum + d.successCount, 0);
    const calculatedSuccessRate = totalAttempts > 0 ? Math.round((totalSuccess / totalAttempts) * 100) : 0;
    console.log(`  Summary: ${totalAttempts} attempts, ${calculatedSuccessRate}% success rate (last 30 days)`);
  }

  console.log('\n=== Seeding completed! ===');
  console.log(`Seeded performance data for ${websites.length} websites.`);
  console.log('You can now test the View Performance feature.');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
