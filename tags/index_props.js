import projectConfig from '/pagic.config.js';
export default {
    config: { "root": "/", ...projectConfig, branch: 'master' },
    'pagePath': "tags/README.md",
    'layoutPath': "tags/_layout.tsx",
    'outputPath': "tags/index.html",
    'title': "标签",
    'content': React.createElement("article", { dangerouslySetInnerHTML: {
            __html: '<h1>标签</h1>'
        } }),
    'head': null,
    'script': React.createElement(React.Fragment, null,
        React.createElement("script", { src: "https://cdn.pagic.org/react@16.13.1/umd/react.production.min.js" }),
        React.createElement("script", { src: "https://cdn.pagic.org/react-dom@16.13.1/umd/react-dom.production.min.js" }),
        React.createElement("script", { src: "/index.js", type: "module" })),
    'contentTitle': React.createElement("h1", { key: "0" }, "\u6807\u7B7E"),
    'contentBody': React.createElement("article", { dangerouslySetInnerHTML: {
            __html: ''
        } }),
    'toc': null,
    'author': "刘阳",
    'contributors': [
        "刘阳"
    ],
    'date': "2021-01-26T15:26:51.000Z",
    'updated': null,
    'excerpt': "",
    'cover': undefined,
    'blog': {
        "isPost": false,
        "posts": [
            {
                "pagePath": "posts/hello-world.md",
                "title": "新的博客，新的起点。",
                "link": "posts/hello-world.html",
                "date": "2021-01-26T15:26:51.000Z",
                "updated": null,
                "author": "刘阳",
                "contributors": [
                    "刘阳"
                ],
                "categories": [
                    "闲谈"
                ],
                "tags": [
                    "博客"
                ],
                "excerpt": "折腾过几次博客，因为这样那样的原因都废弃了。不折腾了，以后会好好写文章。"
            }
        ],
        "categories": [
            {
                "name": "闲谈",
                "count": 1
            }
        ],
        "tags": [
            {
                "name": "博客",
                "count": 1
            }
        ]
    }
};
