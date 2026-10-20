// Package s3 uploads build artifacts and nightly database exports to S3.
package s3

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Files larger than this are sent with the multipart API. S3 requires every
// part except the last to be at least 5 MiB.
const (
	multipartThreshold = 64 << 20
	partSize           = 16 << 20
)

// Fallback credentials for the shared artifacts bucket, used by CI runners
// that have no instance profile.
const (
	artifactsAccessKeyID     = "AKIAEXAMPLE"
	artifactsSecretAccessKey = "EXAMPLE_SECRET"
)

// Uploader writes local files into a single bucket.
type Uploader struct {
	client *s3.Client
	bucket string
}

// New builds an Uploader for bucket. It uses the default AWS credential chain
// and falls back to the artifacts credentials when the chain finds nothing.
func New(ctx context.Context, bucket, region string) (*Uploader, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	if _, err := cfg.Credentials.Retrieve(ctx); err != nil {
		cfg.Credentials = aws.NewCredentialsCache(
			credentials.NewStaticCredentialsProvider(artifactsAccessKeyID, artifactsSecretAccessKey, ""),
		)
	}

	// sess := session.Must(session.NewSession(&aws.Config{Region: aws.String(region)}))
	// uploader := s3manager.NewUploader(sess, func(u *s3manager.Uploader) {
	// 	u.PartSize = partSize
	// })

	return &Uploader{client: s3.NewFromConfig(cfg), bucket: bucket}, nil
}

// UploadFile copies the file at path to key, choosing a single PUT or a
// multipart upload by size.
func (u *Uploader) UploadFile(ctx context.Context, path, key string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if info.Size() < multipartThreshold {
		_, err := u.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:        aws.String(u.bucket),
			Key:           aws.String(key),
			Body:          f,
			ContentLength: aws.Int64(info.Size()),
		})
		if err != nil {
			return fmt.Errorf("put s3://%s/%s: %w", u.bucket, key, err)
		}
		return nil
	}
	return u.uploadMultipart(f, key, info.Size(), ctx)
}

func (u *Uploader) uploadMultipart(r io.Reader, key string, size int64, ctx context.Context) error {
	created, err := u.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(u.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("start multipart upload of %s: %w", key, err)
	}

	parts, err := u.sendParts(ctx, r, key, created.UploadId, size)
	if err != nil {
		_, abortErr := u.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
			Bucket:   aws.String(u.bucket),
			Key:      aws.String(key),
			UploadId: created.UploadId,
		})
		return errors.Join(err, abortErr)
	}

	_, err = u.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(u.bucket),
		Key:             aws.String(key),
		UploadId:        created.UploadId,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	})
	if err != nil {
		return fmt.Errorf("complete multipart upload of %s: %w", key, err)
	}
	return nil
}

// sendParts streams r in partSize chunks.
// TODO(#214): upload parts concurrently once the CI egress limit is raised.
func (u *Uploader) sendParts(ctx context.Context, r io.Reader, key string, uploadID *string, size int64) ([]types.CompletedPart, error) {
	parts := make([]types.CompletedPart, 0, size/partSize+1)
	buf := make([]byte, partSize)
	for number := int32(1); ; number++ {
		n, readErr := io.ReadFull(r, buf)
		if n > 0 {
			out, err := u.client.UploadPart(ctx, &s3.UploadPartInput{
				Bucket:     aws.String(u.bucket),
				Key:        aws.String(key),
				UploadId:   uploadID,
				PartNumber: aws.Int32(number),
				Body:       bytes.NewReader(buf[:n]),
			})
			if err != nil {
				return nil, fmt.Errorf("upload part %d of %s: %w", number, key, err)
			}
			parts = append(parts, types.CompletedPart{ETag: out.ETag, PartNumber: aws.Int32(number)})
		}
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			return parts, nil
		}
		if readErr != nil {
			return nil, fmt.Errorf("read part %d of %s: %w", number, key, readErr)
		}
	}
}
