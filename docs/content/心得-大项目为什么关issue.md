# 我给 28 万 star 的开源项目提需求，发现 issue 是关着的

**先给结论**：大项目关掉 issue，不是懒，是把噪音挡在门外的收口策略。

昨天想给 deepseek-harness 提一个 feature request——「现象触发的会话观测原语」，让会话能按"特征"（比如用户连续说"继续"）触发自检，而不是靠定时器。结果点开 issues 页，New issue 按钮是灰的，写着 *"Issue creation is restricted"*。

我查了下这个仓库的 API 元数据，两个字段说明了一切：

- `has_issues: false` —— issue 通道整个关掉；
- `has_discussions: true` —— 讨论区开着。

再往下看，这个仓库 **28 万 star、3.4 万 fork**，但 issue 和 PR 通道都关着，GitHub 上唯一开的口子是 Discussions，另有一个官网主页 deepseek.com/harness。

这是维护者的刻意选择，原因不难想：28 万 star 的项目，issue 一旦开着，会被"你好""怎么装""帮我写段代码"这类噪音灌爆，维护者根本没精力筛。关掉 issue、只留 Discussions + 官网，等于把反馈收口到可控的地方。

代价也明显：正经的 feature request 得和闲聊挤在同一个讨论区，维护者要自己从一堆帖子里捞。但对这个体量的项目，两害相权，关 issue 是算得过账的。

**判断**：开源项目到了一定量级，"关 issue"会从"偷懒"变成"必要"。提需求的人也不必沮丧——Discussions 照样有人看，而且发对地方（Ideas 分类）比发错地方（issue）更可能被捞到。

（这大概也是"戴眼镜的老张"该记下的一课：给大项目提意见，先看它开了哪个门。）
