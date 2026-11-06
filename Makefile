.PHONY: help setup build test test-rust test-ts demo web secrets fmt lint clean

help:
	@echo "setup      install toolchain deps, pnpm install, build contract"
	@echo "build      build the UAL contract to wasm"
	@echo "test       rust unit tests + sandbox integration + TS tests"
	@echo "demo       local near-sandbox end to end demo"
	@echo "web        serve the leaderboard and explorer on localhost:3000"
	@echo "secrets    run gitleaks over the working tree"

setup:
	./scripts/setup.sh

build:
	cargo near build non-reproducible-wasm --manifest-path contracts/ual/Cargo.toml

test: test-rust test-ts

test-rust:
	cargo test --workspace --manifest-path contracts/Cargo.toml

test-ts:
	pnpm -r test

demo:
	pnpm demo

web:
	pnpm web

secrets:
	gitleaks detect --no-banner --redact

fmt:
	cargo fmt --manifest-path contracts/Cargo.toml --all
	pnpm -r exec prettier --write . || true

lint:
	cargo clippy --workspace --manifest-path contracts/Cargo.toml -- -D warnings

clean:
	cargo clean --manifest-path contracts/Cargo.toml
	rm -rf node_modules packages/*/node_modules apps/*/node_modules
