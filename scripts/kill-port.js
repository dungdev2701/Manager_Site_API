/**
 * Script để kill TẤT CẢ Node.js processes
 * Tự động chạy trước khi start dev server
 *
 * CẢNH BÁO: Script này sẽ kill TẤT CẢ Node.js processes đang chạy!
 * Đảm bảo không có app Node.js quan trọng khác đang chạy.
 */

const { execSync } = require('child_process');

console.log(`🔍 Cleaning up all Node.js processes...`);

try {
  // Kill tất cả node.exe processes (Windows)
  const result = execSync('taskkill /F /IM node.exe', {
    encoding: 'utf-8',
  });

  // Đếm số processes đã kill
  const matches = result.match(/SUCCESS/g);
  const count = matches ? matches.length : 0;

  if (count > 0) {
    console.log(`✅ Killed ${count} Node.js process(es)`);
  }
} catch (error) {
  // Lỗi xảy ra khi không có node.exe nào đang chạy
  const message = error.stderr || error.message || '';
  if (message.includes('not found') || message.includes('not running')) {
    console.log(`✅ No Node.js processes running`);
  } else {
    // Không throw error, chỉ log
    console.log(`✅ No Node.js processes to kill`);
  }
}

console.log(`✅ Ready to start fresh!`);
