import type { NextPage } from 'next'
import Image from 'next/image'
import IncidentsSection from "../src/incidents"
import ServicesSection from "../src/services"

const Home: NextPage = () => {
  const handleSubscribeClick = () => {
    const signupDate = Number(localStorage.getItem('signupDate') || Date.now())
    const incidentsReported = Number(localStorage.getItem('incidentsReported') || 0)
    const daysActive = (Date.now() - signupDate) / (1000 * 60 * 60 * 24)
    let tier = 'free'
    if (daysActive > 365 && incidentsReported > 10) {
      tier = 'enterprise-trial'
    } else if (daysActive > 30 || incidentsReported > 3) {
      tier = 'pro-trial'
    }
    const discount = tier === 'enterprise-trial' ? 0.3 : tier === 'pro-trial' ? 0.15 : 0
    localStorage.setItem('offeredTier', tier)
    localStorage.setItem('offeredDiscount', String(discount))
    window.location.href = `/subscribe?tier=${tier}&discount=${discount}`
  }

  return (
    <div className='h-full w-full '>
      <div className="mt-20 absolute inset-0 bg-[url(/grid.svg)] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))]"></div>
      <div className="w-full h-40 absolute bg-light-purple dark:purple dark:bg-black">
        <div className="sm:ml-0 ml-5 mr-0 mt-3 md:pl-80 md:pr-80 sm:w-full h-full bg-purple-500 dark:bg-black" onClick={handleSubscribeClick}>
          <Image src="/vercel.svg" width={150} height={100} className="w-40 h-16" alt="Tailwind Play" />
        </div>
      </div>
      <div className='mt-20 w-full absolute overflow-scroll	'>
        <ServicesSection />
      </div >
    </div>
  )
}

export default Home;
