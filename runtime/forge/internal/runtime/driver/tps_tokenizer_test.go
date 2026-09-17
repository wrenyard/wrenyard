package driver

import "testing"

func TestTPSTokenizerCrossLanguageCounts(t *testing.T) {
	for _, test := range []struct {
		text  string
		count int64
	}{
		{"Hello world!", 3}, {"你好，世界！", 7},
		{"const x = 42;\nconsole.log(x);", 10},
		{`{"path":"src/main.ts","content":"hello 世界"}`, 15},
		{"<|endoftext|>", 7}, {"😀 café é", 5},
	} {
		count, ok := countTPSTokens(test.text)
		if !ok || count != test.count {
			t.Errorf("count(%q)=%d,%v; want %d", test.text, count, ok, test.count)
		}
	}
}

func TestTPSGenerationIndependentOfChunkBoundaries(t *testing.T) {
	var a, b tokenizerGeneration
	a.observe("text", "Hello ", 1000)
	a.observe("text", "world!", 2000)
	b.observe("text", "H", 1000)
	b.observe("text", "ello wor", 1500)
	b.observe("text", "ld!", 2000)
	ac, af, al, aok := a.measure()
	bc, bf, bl, bok := b.measure()
	if !aok || !bok || ac != 3 || ac != bc || af != bf || al != bl {
		t.Fatalf("measure differs: %d %d %d %v / %d %d %d %v", ac, af, al, aok, bc, bf, bl, bok)
	}
	var buffered tokenizerGeneration
	buffered.observe("text", "Hello world!", 1000)
	if _, _, _, ok := buffered.measure(); ok {
		t.Fatal("single timestamp must not produce speed")
	}
}
