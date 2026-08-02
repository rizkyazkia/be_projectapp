-- Hand-authored migration (not applied via Prisma, see prisma/README section
-- "Prisma to mysql2 migration") - ports the upstream schema changes from
-- muhammadidzoha/be_projectapp (four Prisma migrations, squashed into one
-- direct migration since they were never applied to this fork's database):
--   20260711150130_update_unique_table_class
--   20260713033000_update_unique_nutrition
--   20260713061438_add_field_on_table_nutritions
--   20260713062129_add_monitoring_system
--   20260713123602_update_long_text

-- Classes: class names are now unique per-school instead of globally unique.
ALTER TABLE `classes` DROP INDEX `classes_name_key`;
ALTER TABLE `classes` ADD UNIQUE INDEX `classes_name_school_id_key` (`name`, `school_id`);

-- Nutritions: a family member can now have multiple nutrition/measurement
-- rows (one per monitoring period) instead of exactly one.
ALTER TABLE `nutritions` DROP FOREIGN KEY `nutritions_familyMemberId_fkey`;
ALTER TABLE `nutritions` DROP INDEX `nutritions_familyMemberId_key`;
ALTER TABLE `nutritions`
  ADD COLUMN `measurementDate` TIMESTAMP(2) NOT NULL DEFAULT CURRENT_TIMESTAMP(2),
  ADD COLUMN `monitoringPeriodId` VARCHAR(255) NULL;
ALTER TABLE `nutritions` ADD CONSTRAINT `nutritions_familyMemberId_fkey`
  FOREIGN KEY (`familyMemberId`) REFERENCES `family_members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Responses: tag each questionnaire response with the monitoring period it
-- was answered in (e.g. "Agustus 2026").
ALTER TABLE `responses` ADD COLUMN `periodLabel` VARCHAR(191) NULL;

-- New monitoring_periods table (one row per family per calendar month).
CREATE TABLE `monitoring_periods` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(255) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `createdAt` TIMESTAMP(2) NOT NULL DEFAULT CURRENT_TIMESTAMP(2),
    `updatedAt` TIMESTAMP(2) NOT NULL DEFAULT CURRENT_TIMESTAMP(2),

    UNIQUE INDEX `monitoring_periods_familyId_label_key`(`familyId`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `nutritions` ADD CONSTRAINT `nutritions_monitoringPeriodId_fkey`
  FOREIGN KEY (`monitoringPeriodId`) REFERENCES `monitoring_periods`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `monitoring_periods` ADD CONSTRAINT `monitoring_periods_familyId_fkey`
  FOREIGN KEY (`familyId`) REFERENCES `families`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
