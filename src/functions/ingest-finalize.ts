import { Prisma } from '@prisma/client';
import { Db } from '../infra/db';

/** Moves a job to its terminal status once every chunk is DONE or FAILED. Idempotent. */
export async function finalizeIfComplete(db: Db, jobId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE ingestion_jobs
    SET status = CASE WHEN chunks_failed > 0 OR rows_rejected > 0
                      THEN 'COMPLETED_WITH_ERRORS'::"IngestionJobStatus"
                      ELSE 'COMPLETED'::"IngestionJobStatus" END,
        updated_at = now()
    WHERE id = ${jobId}::uuid
      AND dispatch_done
      AND status = 'PROCESSING'
      AND chunks_done + chunks_failed >= chunks_total
  `);
}
