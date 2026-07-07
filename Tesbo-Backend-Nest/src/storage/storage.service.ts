import { Injectable } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import * as path from "path";
import { AppConfigService } from "../config/app-config.service";

// Object storage abstraction: local disk by default (self-hosted, no setup required), or any
// S3-compatible service (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, ...) when
// STORAGE_DRIVER=s3. Keys are always prefixed per-feature and per-project (e.g.
// "knowledge-base/<organizationId>/<projectId>/<uuid>.<ext>") so objects are organized and can be scoped by
// bucket policy / lifecycle rules per project regardless of backend.
@Injectable()
export class StorageService {
  private readonly s3: S3Client | null;

  constructor(private readonly config: AppConfigService) {
    this.s3 =
      this.config.storageDriver === "s3"
        ? new S3Client({
            region: this.config.s3Region,
            endpoint: this.config.s3Endpoint,
            forcePathStyle: this.config.s3ForcePathStyle,
            credentials: this.config.s3AccessKeyId
              ? { accessKeyId: this.config.s3AccessKeyId, secretAccessKey: this.config.s3SecretAccessKey || "" }
              : undefined
          })
        : null;
    if (this.config.storageDriver === "s3" && !this.config.s3Bucket) {
      throw new Error("S3_BUCKET must be set when STORAGE_DRIVER=s3");
    }
  }

  isS3(): boolean {
    return this.s3 !== null;
  }

  private localPath(key: string): string {
    return path.resolve(this.config.uploadDir, key);
  }

  // Applies the optional S3_BUCKET_FOLDER prefix (e.g. "local", "staging") so multiple
  // environments can share one bucket without colliding.
  private prefixedKey(key: string): string {
    return this.config.s3BucketFolder ? `${this.config.s3BucketFolder}/${key}` : key;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: this.prefixedKey(key),
          Body: body,
          ContentType: contentType
        })
      );
      return;
    }
    const fullPath = this.localPath(key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, body);
  }

  async exists(key: string): Promise<boolean> {
    if (this.s3) return true; // checked lazily via the signed URL request itself
    return fs.existsSync(this.localPath(key));
  }

  // Returns either a short-lived, access-scoped redirect URL (S3) or a local file path to
  // stream directly (local disk) — callers must only call this after their own permission
  // checks pass, since the returned URL/path grants access to the file's contents.
  async getAccessUrl(
    key: string,
    options: { filename: string; inline: boolean; contentType: string }
  ): Promise<{ redirectUrl: string } | { localPath: string }> {
    if (this.s3) {
      const disposition = `${options.inline ? "inline" : "attachment"}; filename="${encodeURIComponent(options.filename)}"`;
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: this.prefixedKey(key),
          ResponseContentDisposition: disposition,
          ResponseContentType: options.contentType
        }),
        { expiresIn: this.config.s3PresignedUrlTtlSeconds }
      );
      return { redirectUrl: url };
    }
    return { localPath: this.localPath(key) };
  }

  async delete(key: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: this.prefixedKey(key) }));
      return;
    }
    await fs.promises.unlink(this.localPath(key)).catch(() => undefined);
  }
}
