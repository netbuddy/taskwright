# 查找知识库的拒绝语

「查找知识库」（search_knowledge）的参数写得不对时的文字（`agent/src/lib/knowledge_search.ts` 的 searchParams）。键的写法见 `rejections_shared.md` 的开头。

## `search_knowledge.query_empty`

用途：query 没有写或者是空的。

query 要写要找的内容，用一句完整的话写出来，不能是空的。

## `search_knowledge.limit_invalid`

用途：limit 写的不是 1 到上限之间的整数。

limit 要写 1 到 {{max}} 的整数，不写是 {{default}}。
