BIN_DIR := bin
HOME_DIR := $(subst \,/,$(HOME))
INSTALL_DIR := $(HOME_DIR)/.local/bin
ifeq ($(OS),)
ifneq ($(WINDIR),)
OS := Windows_NT
endif
endif
GOCACHE := $(shell cache="$$(go env GOCACHE 2>/dev/null)"; if [ -n "$$cache" ] && [ "$$cache" != "off" ]; then printf '%s\n' "$$cache"; else printf '%s\n' "$(HOME_DIR)/.cache/go-build"; fi)
export GOCACHE

ifeq ($(OS),Windows_NT)
FORGE_NAME := forge.exe
else
FORGE_NAME := forge
endif
FORGE := $(INSTALL_DIR)/$(FORGE_NAME)

.PHONY: build test install setup update doctor clean

build:
	mkdir -p $(BIN_DIR)
	go build -o $(BIN_DIR)/$(FORGE_NAME) ./cmd/forge

test:
	go test ./...

# install: build the binary and run forge setup, forcing the stable launcher to
# point at the freshly built artifact.
install: build
	$(BIN_DIR)/$(FORGE_NAME) setup --self-install

# Deprecated aliases — kept for muscle memory.
setup:
	@echo "make setup is deprecated; use 'make install' or 'forge setup' directly."
	@$(MAKE) install

# Bootstrap path for when forge is not yet installed. The canonical update path is `forge update`.
update:
	git pull --ff-only
	$(MAKE) install

doctor:
	$(FORGE) doctor

clean:
	rm -rf $(BIN_DIR)
