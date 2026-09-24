.PHONY: install test dev check

install:
	npm ci
	python3 -m pip install -e 'observatory[test]' -e 'server[test]'

test:
	scripts/test-all.sh

dev:
	scripts/dev.sh

check:
	scripts/check-public.sh
