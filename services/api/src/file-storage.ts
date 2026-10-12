import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HttpError } from "./http";

const uploadUrlLifetimeSeconds = 5 * 60;
const downloadUrlLifetimeSeconds = 5 * 60;
let client: S3Client | undefined;

function storage() {
  const accountId = process.env.FILETASKS_R2_ACCOUNT_ID;
  const accessKeyId = process.env.FILETASKS_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FILETASKS_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.FILETASKS_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new HttpError(503, "File uploads are not configured on this server yet.");
  }
  client ??= new S3Client({
    region: "auto",
    endpoint: process.env.FILETASKS_R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucket };
}

export async function presignUpload(objectKey: string, contentType: string) {
  const { client, bucket } = storage();
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }), {
    expiresIn: uploadUrlLifetimeSeconds,
  });
}

export async function presignDownload(objectKey: string, contentType: string, name: string) {
  const { client, bucket } = storage();
  const filename = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ResponseContentType: contentType,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${filename}`,
  }), { expiresIn: downloadUrlLifetimeSeconds });
}

export async function uploadedObjectMatches(objectKey: string, sizeBytes: number, contentType: string) {
  const { client, bucket } = storage();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return result.ContentLength === sizeBytes && result.ContentType === contentType;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw error;
  }
}

export async function deleteStoredObject(objectKey: string) {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}
