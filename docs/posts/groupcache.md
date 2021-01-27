---
categories:
  - 编程

tags:
  - groupcache
  - 源码阅读

---

# groupcache 源码阅读

> 长文预警，本文会逐行解析 `groupcache` 代码的完整细节，需要花费一定的时间才能读完。

最近闲来无事，就想找个不大不小的开源项目读一读。一番选择困难后，最后选定了 `groupcache`。

这个库是由 Brad Fitzpatrick 于 2013 年开发，并用于 Google 生产环境（dl.google.com）。`groupcache` 有很多精良的设计，例如它的所有权模型避免了并发程序的惊群问题，`singleflight` 设计实现了请求合并等等。`groupcache` 不仅是一份设计优良的好代码，更是被广泛使用的成熟系统。而它的代码行数不过 2000 余行，用来阅读再合适不过了。

因为原项目已经很久没更新，在这期间 Go 语言也发生了一些变化，所以这次源码阅读我选用了一个社区维护的版本：https://github.com/mailgun/groupcache。



### 介绍

`groupcache` 旨在可以代替 `memcached` 部分功能（`memcached` 也是 Brad 开发的），提供高性能的分布式缓存服务。`groupcache` 并不是一个独立的软件，而是一个库，用户通过在主程序中调用其 API 实现缓存功能。

`groupcache` 是分布式软件，节点被称为 `peer`，每个 `peer` 既是客户端也是服务器，我们来看一下当应用程序请求某个 `key` 时，`peer` 的行为。

假设现在集群中有 N 个 `peer`，在 #5 `peer` 中，应用程序发起查询 `Get("foo")`：

1. 因为 `"foo"` 是热点数据，所以在本机内存中？返回该值。

2. 因为 `"foo"` 的所属者是 #5（当前 `peer`），所以在本机内存中？返回该值。

3. 在所有的 N 个 `peer` 中，`"foo"` 的所属者应该是我吗（通过一致性哈希算法确认）？如果是的话，说明当前 `key` 并没有被加载到缓存中，那就从数据源加载它。

   如果在加载的过程中，当前应用程序或者其他 `peer` （通过 RPC）也发起了对 `"foo"` 的查询请求，这些请求会被 block 等待数据加载完成，并最终获得相同的值。

4. 如果 `"foo"` 的所属者不是我，发起 RPC 调用给所属者获取该值。如果 RPC 调用失败，则尝试从本机内存加载。



要实现上面的流程，需要几个基础设施辅助。我们先来看一下这些基础设施的实现细节。



### 一致性哈希算法

我们需要快速地确认某个 `key` 的所属 `peer`，这时候就需要用到一致性哈希算法。该算法将整个哈希值空间组织成一个圆环，假设这个空间的类型为 `uint32`，则空间的范围是 0～2^32-1，如下图：

![hash1.png](https://i.loli.net/2021/01/27/N5zZ3GDClg7h2oc.png)

假设我们现在有一个哈希函数 `string -> uint32`，使用 `peer` 的 IP 或主机名等可以唯一确定一个 `peer` 的字符串，对集群中每个 `peer` 进行哈希。假设我们有四台节点，哈希后每台节点就落在了圆环的不同位置上，如下图：

![hash2.png](https://i.loli.net/2021/01/27/HqNwIJ2Dsm6tMBc.png)

给定任意的 `key`，使用**相同**的哈希函数进行哈希后，`key` 也会落在圆环的位置上，我们规定沿顺时针方向遇到的第一个 `peer` 即为该 `key` 存储的位置即可，如下图：

![hash3.png](https://i.loli.net/2021/01/27/lZfzcF7hEdBqQOY.png)

当 `peer` 的数量较少时，`peer` 的位置很容易分散不够均匀，这会造成数据倾斜，导致大部分的数据存储到了小部分的 `peer` 中。对此，我们可以为每个 `peer` 生成多个虚拟节点，分别计算哈希，所有落在虚拟节点上的值都会定位到实际的 `peer` 中。实践中，通常会将虚拟节点数设置为 32 或更大，保证即使是很少的服务节点也可以做到均匀的数据分布。



### 参考资料

1. 《Consistent hashing and random trees: distributed caching protocols for relieving hot spots on the World Wide Web》https://dl.acm.org/doi/10.1145/258533.258660
2. https://www.cnblogs.com/lpfuture/p/5796398.html 文中部分图片引用自此文