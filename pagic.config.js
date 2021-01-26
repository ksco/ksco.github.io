export default {
    srcDir: 'docs',
    outDir: 'public',
    theme: 'blog',
    title: 'KSCO',
    description: '记录思绪',
    github: 'https://github.com/ksco',
    plugins: ['blog'],
    nav: [
        {
            text: '首页',
            link: '/index.html',
            icon: 'czs-home-l',
        },
        {
            text: '分类',
            link: '/categories/index.html',
            icon: 'czs-category-l',
        },
        {
            text: '标签',
            link: '/tags/index.html',
            icon: 'czs-tag-l',
        },
        {
            text: '归档',
            link: '/archives/index.html',
            icon: 'czs-box-l',
        },
    ],
};
