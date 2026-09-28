-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "lineOfBusiness" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "status" "DocumentStatus" NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "sectionNumber" TEXT,
    "sectionTitle" TEXT NOT NULL,
    "headingPath" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "embedding" vector(1024),

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_sourcePath_key" ON "Document"("sourcePath");

-- CreateIndex
CREATE UNIQUE INDEX "Document_supersedesId_key" ON "Document"("supersedesId");

-- CreateIndex
CREATE INDEX "Chunk_documentId_sectionNumber_idx" ON "Chunk"("documentId", "sectionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_documentId_chunkIndex_key" ON "Chunk"("documentId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
