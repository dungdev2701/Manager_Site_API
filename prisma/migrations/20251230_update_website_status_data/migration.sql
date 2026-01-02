-- Step 2: Migrate existing data to new statuses
-- UNTESTED -> NEW (mới thêm, chưa check)
-- TESTED -> RUNNING (đã test xong, sẵn sàng chạy)
-- ABANDONED -> ERROR (bỏ -> chuyển thành lỗi để review lại)
UPDATE "websites" SET status = 'NEW' WHERE status = 'UNTESTED';
UPDATE "websites" SET status = 'RUNNING' WHERE status = 'TESTED';
UPDATE "websites" SET status = 'ERROR' WHERE status = 'ABANDONED';

-- Step 3: Update default value for new websites
ALTER TABLE "websites" ALTER COLUMN "status" SET DEFAULT 'NEW'::"WebsiteStatus";
