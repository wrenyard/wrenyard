package driver

import (
	"github.com/tiktoken-go/tokenizer"
	"strings"
	"sync"
)

const tokenizerTPSSamplingContract = "tokenizer_v1"
const tokenizerMinimumWindowMS int64 = 100

// A fixed, embedded vocabulary keeps speed comparable across models without
// runtime downloads. Official usage is never replaced by these counts.
var tpsTokenizer = sync.OnceValues(func() (tokenizer.Codec, error) {
	return tokenizer.Get(tokenizer.Cl100kBase)
})
var tpsTokenizerMu sync.Mutex

func countTPSTokens(text string) (int64, bool) {
	if text == "" {
		return 0, true
	}
	codec, err := tpsTokenizer()
	if err != nil {
		return 0, false
	}
	tpsTokenizerMu.Lock()
	defer tpsTokenizerMu.Unlock()
	count, err := codec.Count(text)
	return int64(count), err == nil
}

// Concatenate each content block before encoding; counting individual deltas
// would make the result depend on how a client splits its stream.
type tokenizerGeneration struct {
	blocks  map[string]*strings.Builder
	firstMS int64
	lastMS  int64
	invalid bool
}

func (g *tokenizerGeneration) observe(key, text string, at int64) {
	if text == "" {
		return
	}
	if at <= 0 || g.lastMS > at {
		g.invalid = true
		return
	}
	if g.blocks == nil {
		g.blocks = make(map[string]*strings.Builder)
		g.firstMS = at
	}
	block := g.blocks[key]
	if block == nil {
		block = &strings.Builder{}
		g.blocks[key] = block
	}
	block.WriteString(text)
	g.lastMS = at
}

func (g *tokenizerGeneration) measure() (tokens, first, last int64, ok bool) {
	if g.invalid || g.blocks == nil || g.lastMS-g.firstMS < tokenizerMinimumWindowMS {
		return 0, 0, 0, false
	}
	for _, block := range g.blocks {
		count, valid := countTPSTokens(block.String())
		if !valid {
			return 0, 0, 0, false
		}
		tokens += count
	}
	return tokens, g.firstMS, g.lastMS, tokens > 0
}
