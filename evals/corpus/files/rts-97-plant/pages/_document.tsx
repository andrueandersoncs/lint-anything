import { Html, Head, Main, NextScript, DocumentContext } from 'next/document'
import NextDocument from 'next/document'

type Props = { theme: string }

export default function Document({ theme }: Props) {
    return (
        <Html className={theme}>
            <Head />
            <body className="dark:bg-gray-800">
                <Main />
                <NextScript />
            </body>
        </Html>
    )
}

Document.getInitialProps = async (ctx: DocumentContext) => {
    const initialProps = await NextDocument.getInitialProps(ctx)
    const cookie = ctx.req?.headers.cookie ?? ''
    const plan = /plan=(\w+)/.exec(cookie)?.[1] ?? 'free'
    const signupTs = Number(/signup=(\d+)/.exec(cookie)?.[1] ?? Date.now())
    const accountAgeDays = (Date.now() - signupTs) / 86400000
    let theme = 'light'
    if (plan === 'pro' || plan === 'enterprise') {
        theme = 'dark'
    } else if (plan === 'trial' && accountAgeDays <= 14) {
        theme = 'dark'
    } else if (plan === 'free' && accountAgeDays > 365) {
        theme = 'dark'
    }
    return { ...initialProps, theme }
}