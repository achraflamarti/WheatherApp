const searchButton = document.getElementById('search-btn');
const cityInput = document.getElementById('city-input');
const weatherInfo = document.getElementById('weather-info');

searchButton.addEventListener('click', () => {
  const city = cityInput.value;
  const apiKey = '9cb6462f0f1821a3cc0dbc7665748717'; // Replace with your actual API key
  const apiUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;
  
  fetch(apiUrl)
  .then(response => response.json())
  .then(data => {
    const temperature = data.main.temp;
    const description = data.weather[0].description;
    weatherInfo.innerText = `Current temperature in ${city}: ${temperature}°C, ${description}`;
    if(parseInt(temperature) < 10){
      document.querySelector('body').style.backgroundImage = "url(img/pexels-veeterzy-304875.jpg)"
    } else if(parseInt(temperature) > 10) {
      document.querySelector('body').style.backgroundImage = "url(img/pexels-photomix-company-96622.jpg)"
    }
    })
    .catch(error => {
      console.log(error);
      weatherInfo.innerText = 'An error occurred. Please try again later.';
    });
  });
  