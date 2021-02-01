---
categories:
  - 编程

tags:
  - groupcache
  - 源码阅读

---

# groupcache 源码阅读

> 长文预警，本文会逐行解析 `groupcache` 代码的完整细节，需要花费一定的时间才能读完全文。

最近闲来无事，就想找个不大不小的开源项目读一读。一番选择困难后，最后选定了 `groupcache`。

这个库是由 Brad Fitzpatrick 于 2013 年开发，并用于 Google 生产环境（dl.google.com）。`groupcache` 有很多精良的设计，例如它的所有权模型避免了并发程序的惊群问题，`singleflight` 设计实现了请求合并等等。`groupcache` 不仅是一份设计优良的好代码，更是一个被广泛使用的成熟系统。而它的代码行数不过 2000 余行，用来阅读再合适不过了。

因为原项目已经很久没更新，在这期间 Go 语言也发生了一些变化，所以这次源码阅读我选用了一个社区维护的版本：https://github.com/mailgun/groupcache。



### 介绍

`groupcache` 旨在可以代替 `memcached` 部分功能（`memcached` 也是 Brad 开发的），提供高性能的分布式缓存服务。`groupcache` 并不是一个独立的软件，而是一个库，用户通过在主程序中调用其 API 实现缓存功能。

`groupcache` 是分布式软件，节点被称为 `peer`，每个 `peer` 既是客户端也是服务器，我们来看一下当应用程序请求某个 `key` 时，`peer` 的行为。

假设现在集群中有 N 个 `peer`，在 #5 `peer` 中，应用程序发起查询 `Get("foo")`：

1. 因为 `"foo"` 是热点数据，所以在本机内存中？返回该值。

2. 因为 `"foo"` 的所属者是 #5（当前 `peer`），所以数据在本机内存中？返回该值。

3. 在所有的 N 个 `peer` 中，`"foo"` 的所属者应该是我吗（通过一致性哈希算法确认）？如果是的话，说明当前 `key` 并没有被加载到缓存中，那就从数据源加载它。

   如果在加载的过程中，当前应用程序或者其他 `peer` （通过 RPC）也发起了对 `"foo"` 的查询请求，这些请求会被 block 等待数据加载完成，并最终获得相同的值。

4. 如果 `"foo"` 的所属者不是我，发起 RPC 调用给所属者获取该值。如果 RPC 调用失败，则尝试从本机内存加载。



要实现上面的流程，需要几个基础设施辅助。我们先来看一下这些基础设施的实现细节。



## 基础设施



### 一致性哈希算法

我们需要快速地确认某个 `key` 的所属 `peer`，这时候就需要用到一致性哈希算法<sup>[1]</sup>。该算法将整个哈希值空间组织成一个圆环，假设这个空间的类型为 `uint32`，则空间的范围是 0～2^32-1，如下图<sup>[2]</sup>：

![hash1.png](https://i.loli.net/2021/01/27/N5zZ3GDClg7h2oc.png)

假设我们现在有一个哈希函数 `string -> uint32`，使用 `peer` 的 IP 或主机名等可以唯一确定一个 `peer` 的字符串，对集群中每个 `peer` 进行哈希。假设我们有四台节点，哈希后每台节点就落在了圆环的不同位置上，如下图<sup>[2]</sup>：

![hash2.png](https://i.loli.net/2021/01/27/HqNwIJ2Dsm6tMBc.png)

给定任意的 `key`，使用**相同**的哈希函数进行哈希后，`key` 也会落在圆环的位置上，我们规定沿顺时针方向遇到的第一个 `peer` 即为该 `key` 存储的位置，如下图<sup>[2]</sup>：

![hash3.png](https://i.loli.net/2021/01/27/lZfzcF7hEdBqQOY.png)

这样，对于任意 `key`，只需要求出其哈希值，然后使用二分查找即可快速确定存储位置。

当 `peer` 的数量较少时，`peer` 的位置很容易分散不够均匀，这会造成数据倾斜，即大部分的数据存储到了小部分的 `peer` 中。对此，我们可以为每个 `peer` 生成多个虚拟节点，分别计算哈希，所有落在虚拟节点上的值都会定位到实际的 `peer` 中。实践中，通常会将虚拟节点数设置为 32 或更大，保证即使是很少的服务节点也可以做到均匀的数据分布。

理论完了，来看[代码](https://github.com/mailgun/groupcache/blob/master/consistenthash/consistenthash.go)。

```go
type Hash func(data []byte) uint64
```

> 定义 Hash 类型。这样可以允许使用者根据需要定制哈希函数。





```go
type Map struct {
	hash     Hash
	replicas int
	keys     []int // Sorted
	hashMap  map[int]string
}
```

> 定义一致性哈希的数据结构。`replicas`  是虚拟节点的数量，`keys` 数组存放所有的虚拟节点的哈希值，逻辑中会保证这个数组是排序过的，这也就是 “环”，最后 `hashMap` 的键是虚拟节点的哈希值，值是 `peer` 的唯一字符串，此字段用于查找 `keys` 中的哈希对应的节点。





```go
func New(replicas int, fn Hash) *Map {
	m := &Map{
		replicas: replicas,
		hash:     fn,
		hashMap:  make(map[int]string),
	}
	if m.hash == nil {
		m.hash = fnv1.HashBytes64
	}
	return m
}
```

> 创建 `Map` 结构





```go
func (m *Map) IsEmpty() bool {
	return len(m.keys) == 0
}
```

> 判断环是否为空





```go
func (m *Map) Add(keys ...string) {
	for _, key := range keys {
		for i := 0; i < m.replicas; i++ {
			hash := int(m.hash([]byte(fmt.Sprintf("%x", md5.Sum([]byte(strconv.Itoa(i)+key))))))
			m.keys = append(m.keys, hash)
			m.hashMap[hash] = key
		}
	}
	sort.Ints(m.keys)
}
```

> `Add` 函数可以实现将多个 `peer` 添加到环中，注意最后需要将 `keys` 排序。





```go
func (m *Map) Get(key string) string {
	if m.IsEmpty() {
		return ""
	}

	hash := int(m.hash([]byte(key)))

	// Binary search for appropriate replica.
	idx := sort.Search(len(m.keys), func(i int) bool { return m.keys[i] >= hash })

	// Means we have cycled back to the first replica.
	if idx == len(m.keys) {
		idx = 0
	}

	return m.hashMap[m.keys[idx]]
}
```

> 对于任意给定的 `key`，获取距离最近的 `peer`。注意代码是怎样使用二分法快速查找以及怎样处理“环”的头尾相接的。





### 最近最少使用算法（LRU）

`groupcache` 使用 LRU 作为缓存的置换算法。缓存区的大小是有限的，当缓存区塞满之后，势必要淘汰一些旧数据来为新数据腾出坑位。LRU 说： **那就淘汰掉最久没有用过的那些数据吧！** 这便是 LRU 的核心思想了。

因为我们需要淘汰掉最久未使用的数据，所以需要一个有序的数据结构来记录数据被使用的时间顺序。另外我们要实现的是一个缓存系统，所以插入和删除的时间复杂度都要求是 O(1)，符合这个条件的也就是双向链表了。

另外我们还想要读取缓存操作也是 O(1)，可以使用哈希表，键为缓存的 key，值为对应双向链表中元素的内存地址。

1. SET 操作。如果 key 在哈希表中已存在，我们将双向链表中的对应元素挪到最前面，然后将元素的值设置为新值。否则，我们直接将新元素放到双向链表的最前面，并更新哈希表。

   然后判断缓冲区是否已满。如果缓冲区满，则将双向链表中最后一个元素从链表和哈希表中都移除。

2. GET 操作。如果 key 在哈希表中不存在，获取失败。否则我们将双向链表中的对应元素挪到最前面，并返回元素的值。

3. REMOVE 操作。如果 key 在哈希表中存在，将其从哈希表和双向链表中删除即可。

来看[代码](https://github.com/mailgun/groupcache/blob/master/lru/lru.go)。

```go
// A Key may be any value that is comparable. See http://golang.org/ref/spec#Comparison_operators
type Key interface{}

type entry struct {
	key    Key
	value  interface{}
	expire time.Time
}
```

> 定义 Cache 中的元素类型。`expire` 记录 `key` 的过期时间，已过期的 `key` 会在 `Get` 时被动删除。





```go
// Cache is an LRU cache. It is not safe for concurrent access.
type Cache struct {
	// MaxEntries is the maximum number of cache entries before
	// an item is evicted. Zero means no limit.
	MaxEntries int

	// OnEvicted optionally specifies a callback function to be
	// executed when an entry is purged from the cache.
	OnEvicted func(key Key, value interface{})

	ll    *list.List
	cache map[interface{}]*list.Element
}
```

> 定义 Cache 结构。`ll` 是双向链表，使用的是标准库提供的实现；cache 是哈希表。`OnEvicted` 不为空时，每当 `entry` 被移出缓存时，就会调用该函数。注意此实现并没有考虑线程安全，即不能在多个 goroutine 中使用同一个 Cache 实例。





```go
// New creates a new Cache.
// If maxEntries is zero, the cache has no limit and it's assumed
// that eviction is done by the caller.
func New(maxEntries int) *Cache {
	return &Cache{
		MaxEntries: maxEntries,
		ll:         list.New(),
		cache:      make(map[interface{}]*list.Element),
	}
}
```

> 创建 Cache。



```go
func (c *Cache) removeElement(e *list.Element) {
	c.ll.Remove(e)
	kv := e.Value.(*entry)
	delete(c.cache, kv.key)
	if c.OnEvicted != nil {
		c.OnEvicted(kv.key, kv.value)
	}
}
```

> 将某个元素移出 Cache，注意该函数中对于 `OnEvicted` 的调用。



```go
// Add adds a value to the cache.
func (c *Cache) Add(key Key, value interface{}, expire time.Time) {
	if c.cache == nil {
		c.cache = make(map[interface{}]*list.Element)
		c.ll = list.New()
	}
	if ee, ok := c.cache[key]; ok {
		c.ll.MoveToFront(ee)
		ee.Value.(*entry).value = value
		return
	}
	ele := c.ll.PushFront(&entry{key, value, expire})
	c.cache[key] = ele
	if c.MaxEntries != 0 && c.ll.Len() > c.MaxEntries {
		c.RemoveOldest()
	}
}
```

> 将某个值加到内存中。分了两种情况：更新已有 `key` 和插入新 `key`



```go
// Get looks up a key's value from the cache.
func (c *Cache) Get(key Key) (value interface{}, ok bool) {
	if c.cache == nil {
		return
	}
	if ele, hit := c.cache[key]; hit {
		entry := ele.Value.(*entry)
		// If the entry has expired, remove it from the cache
		if !entry.expire.IsZero() && entry.expire.Before(time.Now()) {
			c.removeElement(ele)
			return nil, false
		}

		c.ll.MoveToFront(ele)
		return entry.value, true
	}
	return
}
```

> 查询缓存中对应 `key` 的值，注意对于过期 `entry` 的处理。



```go
// Remove removes the provided key from the cache.
func (c *Cache) Remove(key Key) {
	if c.cache == nil {
		return
	}
	if ele, hit := c.cache[key]; hit {
		c.removeElement(ele)
	}
}
```

> 将 `key` 从缓存中移除。



```go
// RemoveOldest removes the oldest item from the cache.
func (c *Cache) RemoveOldest() {
	if c.cache == nil {
		return
	}
	ele := c.ll.Back()
	if ele != nil {
		c.removeElement(ele)
	}
}
```

> 将最久未使用的 `key` 从缓存中移除。



```go
// Len returns the number of items in the cache.
func (c *Cache) Len() int {
	if c.cache == nil {
		return 0
	}
	return c.ll.Len()
}
```

> 获取缓存中 `key` 的个数。



```go
// Clear purges all stored items from the cache.
func (c *Cache) Clear() {
	if c.OnEvicted != nil {
		for _, e := range c.cache {
			kv := e.Value.(*entry)
			c.OnEvicted(kv.key, kv.value)
		}
	}
	c.ll = nil
	c.cache = nil
}
```

> 清除缓存。



### SingleFlight

在高并发的缓存系统中，**缓存击穿** 是一个常见问题。假设系统使用 Redis 作为缓存中间件。当一个热点数据被并发请求时，如果此时 Redis 中对于该数据的缓存已经过期，这些并发的请求就会同时打到下游的数据库中，造成缓存系统的失效，如下图<sup>[3]</sup>：

![2020-01-23-15797104328070-golang-query-without-single-flight.png](https://i.loli.net/2021/01/30/EKuk9hOCQc1U3Wj.png)



SingleFlight 可以有效地抑制客户端对同一个键值对的并发请求，减少对于下游数据库的瞬时流量，如下图<sup>[3]</sup>：

![2020-01-23-15797104328078-golang-extension-single-flight.png](https://i.loli.net/2021/01/30/L6SlQ4sIKTu9Yto.png)



Go 语言的标准库中也提供了 [singleflight](https://github.com/golang/sync/blob/master/singleflight/singleflight.go) 的实现，但 groupcache 并没有使用，而是选择[自己实现](https://github.com/mailgun/groupcache/blob/master/singleflight/singleflight.go)。因为作者在编写 groupcache 时，Go 语言的标准库中还没有提供该实现。我们本次代码阅读也以作者自己的实现为准。

如果对于某个 `key` 的请求已经存在且正在进行中，则对于该 key 的新请求就会被堵塞，直到请求完成后，所有被堵塞的请求也将获得请求的结果，并结束堵塞。

我们来看一下[代码](https://github.com/mailgun/groupcache/blob/master/singleflight/singleflight.go)的实现细节。

```go
// call is an in-flight or completed Do call
type call struct {
	wg  sync.WaitGroup
	val interface{}
	err error
}
```

> `call` 表示一个进行中或者已经完成的请求，其中 `wg` 用于实现新请求的堵塞机制。如果你对 `WaitGroup` 缺乏了解，可以通过[此处](https://gobyexample.com/waitgroups)快速熟悉用法，更多细节可以阅读 [GoDoc 页面](https://golang.org/pkg/sync/#WaitGroup)。





```go
// Group represents a class of work and forms a namespace in which
// units of work can be executed with duplicate suppression.
type Group struct {
	mu sync.Mutex       // protects m
	m  map[string]*call // lazily initialized
}

```

> Group 通过持有一个 `map` 和保护 `map` 的锁，来实现对请求的管理。



```go
// Do executes and returns the results of the given function, making
// sure that only one execution is in-flight for a given key at a
// time. If a duplicate comes in, the duplicate caller waits for the
// original to complete and receives the same results.
func (g *Group) Do(key string, fn func() (interface{}, error)) (interface{}, error) {
	g.mu.Lock()
	if g.m == nil {
		g.m = make(map[string]*call)
	}
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := new(call)
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()

	return c.val, c.err
}
```

> `Do` 函数接受两个参数：`key` 和获取 key 值对应的函数。`Do` 方法支持并发调用，并保证对于同一个 `key` 的并发调用，`fn` 只会执行一次，所有的并发调用都会拿到相同的返回值。下面我们来逐行解释一下这个函数的实现：
>
> ```go
> g.mu.Lock()
> ```
>
> 因为我们接下来要操作 `m`，所以先加锁。
>
> 
>
> ```go
> if g.m == nil {
> 	g.m = make(map[string]*call)
> }
> ```
> 懒初始化。
>
> 
>
> ```go
> if c, ok := g.m[key]; ok {
> 	g.mu.Unlock()
> 	c.wg.Wait()
> 	return c.val, c.err
> }
> ```
> 当 `key` 存在于 `m` 中时，说明当前的 `call` 正在执行中。进入到 `if` 中后，我们后续不再需要操作 `m` 了，所以先释放锁。然后调用 `wg.Wait()` 等待 `call` 执行成功。最终将执行结果返回。
>
> 
>
> ```go
> c := new(call)
> c.wg.Add(1)
> g.m[key] = c
> g.mu.Unlock()
> ```
>
> 如果 `key` 不存在于 `m` 中，说明当前请求并没有在执行，我们创建一个新请求，并调用 `wg.Add(1)` 将请求的引用数 +1，这样其他并发的 `Do` 调用就会在 `if` 中堵塞在 `wg.Wait()` 语句处，直到我们释放该引用为止。
>
> 然后设置 `m[key]`，因为后续的代码中不再需要操作 `m`，设置完后释放锁。
>
> 
>
> ```go
> 	c.val, c.err = fn()
> 	c.wg.Done()
> ```
>
> 执行 `fn`，执行完成后，调用 `wg.Done()` 释放引用，此时其他的并发 `Do` 调用也会停止堵塞，并获得 `call` 中的执行结果。
>
> 
>
> ```go
> 	g.mu.Lock()
> 	delete(g.m, key)
> 	g.mu.Unlock()
> 
> 	return c.val, c.err
> ```
>
> 最后我们将 `m[key]` 删除，并将执行结果返回。



```go
// Lock prevents single flights from occurring for the duration
// of the provided function. This allows users to clear caches
// or preform some operation in between running flights.
func (g *Group) Lock(fn func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	fn()
}
```

> `Lock` 方法会执行 `fn`函数，并通过在执行期间持有锁，保证这段时间不会有任何新的请求被触发。可以使用该方法安全地清除所有的缓存，或者在两次 SingleFlight 中间执行一些操作。



### ByteView

[ByteView](https://github.com/mailgun/groupcache/blob/master/byteview.go) 隐藏了 string 和 []byte 转换的细节，封装了一个结构体和与之绑定的一系列方法来表示和操作文本数据。代码直观易懂，这里就不再浪费读者的时间了，建议直接读一下[源代码](https://github.com/mailgun/groupcache/blob/master/byteview.go)。



### Protobuf

Protocol Buffers 是谷歌公司出品的消息序列化与反序列化协议，并提供了常见编程语言的 Code Generator。groupcache 使用了该协议，在 [groupcache.proto](https://github.com/mailgun/groupcache/blob/master/groupcachepb/groupcache.proto) 中定义。了解该协议可以参考其[官方网站](https://developers.google.com/protocol-buffers)，此处不在赘述。



到这里，groupcache 的基础设施已经介绍完毕了，来看一下核心代码。



## 核心逻辑

// TODO



### 参考资料

1. 《Consistent hashing and random trees: distributed caching protocols for relieving hot spots on the World Wide Web》https://dl.acm.org/doi/10.1145/258533.258660
2. https://www.cnblogs.com/lpfuture/p/5796398.html 文中部分图片和文字描述引用自此文。
3. https://draveness.me/golang/docs/part3-runtime/ch06-concurrency/golang-sync-primitives/#singleflight 文中部分图片和文字描述引用自此文。

