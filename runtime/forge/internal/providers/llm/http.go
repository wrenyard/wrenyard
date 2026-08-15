package llm

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	defaultHTTPTimeout  = 20 * time.Second
	defaultMaxRetries   = 2
	defaultRetryBackoff = 250 * time.Millisecond
	maxRetryBackoff     = 5 * time.Second
	maxResponseBytes    = 4 * 1024 * 1024
)

// DefaultTransportOptions returns the CLI transport defaults. Callers may
// override individual values without changing the provider request body.
func DefaultTransportOptions() TransportOptions {
	return TransportOptions{
		Timeout:      defaultHTTPTimeout,
		MaxRetries:   defaultMaxRetries,
		RetryBackoff: defaultRetryBackoff,
	}
}

func normalizeTransportOptions(opts TransportOptions) TransportOptions {
	if opts.Timeout <= 0 {
		opts.Timeout = defaultHTTPTimeout
	}
	if opts.MaxRetries < 0 {
		opts.MaxRetries = 0
	}
	if opts.RetryBackoff <= 0 {
		opts.RetryBackoff = defaultRetryBackoff
	}
	return opts
}

func retryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= http.StatusInternalServerError
}

func retryDelay(base time.Duration, retry int) time.Duration {
	delay := base
	for i := 0; i < retry; i++ {
		if delay >= maxRetryBackoff/2 {
			return maxRetryBackoff
		}
		delay *= 2
	}
	if delay > maxRetryBackoff {
		return maxRetryBackoff
	}
	return delay
}

func doJSONPost(url string, headers http.Header, body []byte, opts TransportOptions) (int, []byte, error) {
	opts = normalizeTransportOptions(opts)
	client := &http.Client{Timeout: opts.Timeout}

	var lastErr error
	for attempt := 0; attempt <= opts.MaxRetries; attempt++ {
		httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return 0, nil, fmt.Errorf("create request: %w", err)
		}
		httpReq.Header = headers.Clone()

		resp, err := client.Do(httpReq)
		if err != nil {
			lastErr = fmt.Errorf("http request: %w", err)
			if attempt < opts.MaxRetries {
				time.Sleep(retryDelay(opts.RetryBackoff, attempt))
				continue
			}
			return 0, nil, lastErr
		}

		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("read response: %w", readErr)
			if attempt < opts.MaxRetries {
				time.Sleep(retryDelay(opts.RetryBackoff, attempt))
				continue
			}
			return 0, nil, lastErr
		}

		if retryableStatus(resp.StatusCode) && attempt < opts.MaxRetries {
			time.Sleep(retryDelay(opts.RetryBackoff, attempt))
			continue
		}
		return resp.StatusCode, respBody, nil
	}

	return 0, nil, lastErr
}
